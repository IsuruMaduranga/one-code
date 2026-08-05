import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { permissionGateFactory } from "../../extensions/workflow/permission-gate.ts";

type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }) => { block?: boolean; reason?: string } | undefined;

function buildGate(settings: object): ToolCallHandler {
	const cwd = mkdtempSync(join(os.tmpdir(), "wf-gate-cwd-"));
	const home = mkdtempSync(join(os.tmpdir(), "wf-gate-home-"));
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(settings));

	const gate = permissionGateFactory(cwd, home);
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
	it("blocks deny-ruled commands", () => {
		const handler = buildGate({ permissions: { deny: ["Bash(rm -rf:*)"] } });
		const result = handler({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/Denied by permission rules/);
	});

	it("allows explicitly allowed commands and safe tools", () => {
		const handler = buildGate({ permissions: { allow: ["Bash(npm run test:*)"] } });
		expect(handler({ toolName: "bash", input: { command: "npm run test:unit" } })).toBeUndefined();
		expect(handler({ toolName: "read", input: { path: "/etc/hosts" } })).toBeUndefined();
	});

	it("auto-allows edits (acceptEdits parity) but blocks unmatched bash fail-closed", () => {
		const handler = buildGate({ permissions: {} });
		expect(handler({ toolName: "edit", input: { path: "src/a.ts" } })).toBeUndefined();
		const result = handler({ toolName: "bash", input: { command: "curl https://example.com" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/interactive approval/);
	});

	it("never gates the workflow's own structured_output tool", () => {
		const handler = buildGate({ permissions: {} });
		expect(handler({ toolName: "structured_output", input: { combined: "x" } })).toBeUndefined();
	});

	it("deny wins even under bypassPermissions defaultMode", () => {
		const handler = buildGate({
			permissions: { deny: ["Bash(git push:*)"], defaultMode: "bypassPermissions" },
		});
		expect(handler({ toolName: "bash", input: { command: "git push origin main" } })?.block).toBe(true);
		expect(handler({ toolName: "bash", input: { command: "curl https://example.com" } })).toBeUndefined();
	});
});
