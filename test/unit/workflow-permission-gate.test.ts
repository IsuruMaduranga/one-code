import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { permissionGateFactory } from "../../extensions/lib/permission-gate.ts";

type ToolCallHandler = (
	event: { toolName: string; input: Record<string, unknown> },
) => Promise<{ block?: boolean; reason?: string } | undefined>;

function buildGate(settings: object, getBridge?: Parameters<typeof permissionGateFactory>[3]): ToolCallHandler {
	const cwd = mkdtempSync(join(os.tmpdir(), "wf-gate-cwd-"));
	const home = mkdtempSync(join(os.tmpdir(), "wf-gate-home-"));
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(settings));

	const gate = permissionGateFactory(cwd, home, undefined, getBridge);
	const factory = typeof gate === "function" ? gate : gate.factory;
	let handler: ToolCallHandler | undefined;
	const fakePi = {
		on: (event: string, h: ToolCallHandler) => {
			if (event === "tool_call") handler = h;
		},
	};
	factory(fakePi as never);
	if (!handler) throw new Error("gate did not register a tool_call handler");
	return handler;
}

describe("permissionGateFactory", () => {
	it("blocks deny-ruled commands", async () => {
		const handler = buildGate({ permissions: { deny: ["Bash(rm -rf:*)"] } });
		const result = await handler({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/Denied by permission rules/);
	});

	it("allows explicitly allowed commands and safe tools", async () => {
		const handler = buildGate({ permissions: { allow: ["Bash(npm run test:*)"] } });
		expect(await handler({ toolName: "bash", input: { command: "npm run test:unit" } })).toBeUndefined();
		expect(await handler({ toolName: "read", input: { path: "/etc/hosts" } })).toBeUndefined();
	});

	it("auto-allows edits (acceptEdits parity) but blocks unmatched bash fail-closed", async () => {
		const handler = buildGate({ permissions: {} });
		expect(await handler({ toolName: "edit", input: { path: "src/a.ts" } })).toBeUndefined();
		const result = await handler({ toolName: "bash", input: { command: "curl https://example.com" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/interactive approval/);
	});

	it("never gates the workflow's own structured_output tool", async () => {
		const handler = buildGate({ permissions: {} });
		expect(await handler({ toolName: "structured_output", input: { combined: "x" } })).toBeUndefined();
	});

	it("deny wins even under bypassPermissions defaultMode", async () => {
		const handler = buildGate({
			permissions: { deny: ["Bash(git push:*)"], defaultMode: "bypassPermissions" },
		});
		expect((await handler({ toolName: "bash", input: { command: "git push origin main" } }))?.block).toBe(true);
		expect(await handler({ toolName: "bash", input: { command: "curl https://example.com" } })).toBeUndefined();
	});

	it("delegates to the parent bridge when one is provided (allow + block pass through)", async () => {
		const calls: Array<{ toolName: string; cwd: string }> = [];
		const handler = buildGate({ permissions: { deny: ["Bash(rm -rf:*)"] } }, () => async (call) => {
			calls.push({ toolName: call.toolName, cwd: call.cwd });
			// The bridge's decision wins over the local rules (which would deny this rm).
			return call.toolName === "bash" ? { block: true as const, reason: "bridge says no" } : undefined;
		});
		expect(await handler({ toolName: "read", input: { path: "/etc/hosts" } })).toBeUndefined();
		const blocked = await handler({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toBe("bridge says no");
		expect(calls.map((c) => c.toolName)).toEqual(["read", "bash"]);
	});

	it("fails closed when the bridge throws", async () => {
		const handler = buildGate({ permissions: {} }, () => async () => {
			throw new Error("boom");
		});
		const result = await handler({ toolName: "edit", input: { path: "src/a.ts" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/fail safe/);
	});

	it("never routes the runtime's own tools through the bridge", async () => {
		let bridgeCalls = 0;
		const handler = buildGate({ permissions: {} }, () => async () => {
			bridgeCalls++;
			return { block: true as const, reason: "should not reach" };
		});
		expect(await handler({ toolName: "structured_output", input: {} })).toBeUndefined();
		expect(bridgeCalls).toBe(0);
	});
});
