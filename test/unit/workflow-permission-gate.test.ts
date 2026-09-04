import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localGateMode } from "../../extensions/lib/permission-gate.ts";
import { persistProjectAllowApproval } from "../../extensions/permissions/project-trust.ts";
import { buildGate as buildGateHarness } from "./helpers/permission-gate-harness.ts";

const buildGate = (...args: Parameters<typeof buildGateHarness>) => buildGateHarness(...args).handler;

describe("permissionGateFactory", () => {
	it("blocks deny-ruled commands", async () => {
		const handler = buildGate({ permissions: { deny: ["Bash(rm -rf:*)"] } });
		const result = await handler({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/Denied by permission rules/);
	});

	it("allows explicitly allowed commands and safe tools", async () => {
		const handler = buildGate({ permissions: { allow: ["Bash(npm run test:*)"] } });
		expect(await handler({ toolName: "bash", input: { command: "npm run test -- --grep x" } })).toBeUndefined();
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

describe("permissionGateFactory — mode, ask rules, project consent (P8/P10)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("localGateMode: the published live mode wins, then defaultMode, then acceptEdits", () => {
		expect(localGateMode("plan", "bypassPermissions")).toBe("plan");
		expect(localGateMode("manual", undefined)).toBe("default");
		expect(localGateMode("nonsense", "dontAsk")).toBe("dontAsk");
		expect(localGateMode(undefined, undefined)).toBe("acceptEdits");
	});

	it("honours the parent's live mode: default mode has no one to ask, so an edit is denied", async () => {
		vi.stubEnv("CC_PERMISSION_MODE", "default");
		const handler = buildGate({ permissions: {} });
		const result = await handler({ toolName: "edit", input: { path: "src/a.ts" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/interactive approval/);
	});

	it("auto mode without a bridge: edits inside the cwd pass, anything else fails closed", async () => {
		vi.stubEnv("CC_PERMISSION_MODE", "auto");
		const { handler, cwd } = buildGateHarness({ permissions: {} });
		expect(await handler({ toolName: "edit", input: { path: join(cwd, "src", "a.ts") } })).toBeUndefined();
		const outside = await handler({ toolName: "write", input: { path: join(os.tmpdir(), "elsewhere.txt"), content: "x" } });
		expect(outside?.block).toBe(true);
		expect(outside?.reason).toMatch(/outside the working directory/);
		const shell = await handler({ toolName: "bash", input: { command: "npm test" } });
		expect(shell?.block).toBe(true);
		expect(shell?.reason).toMatch(/classifier is only reachable/);
	});

	it("an ask rule is honoured (denied, since nothing here can ask)", async () => {
		const handler = buildGate({ permissions: { ask: ["Edit(src/**)"] } });
		expect((await handler({ toolName: "edit", input: { path: "src/a.ts" } }))?.block).toBe(true);
		expect(await handler({ toolName: "edit", input: { path: "lib/b.ts" } })).toBeUndefined();
	});

	it("a repo's own allow rules count only with the user's stored consent", async () => {
		const store = mkdtempSync(join(os.tmpdir(), "gate-state-"));
		vi.stubEnv("ONECODE_STATE_DIR", store);
		const project = { permissions: { allow: ["Bash(curl:*)"] } };
		const untrusted = buildGateHarness({ permissions: {} }, undefined, project);
		expect((await untrusted.handler({ toolName: "bash", input: { command: "curl https://example.com" } }))?.block).toBe(true);

		const trusted = buildGateHarness({ permissions: {} }, undefined, project);
		persistProjectAllowApproval(trusted.cwd, ["Bash(curl:*)"]);
		const handler = captureAfterConsent(trusted.cwd, trusted.home);
		expect(await handler({ toolName: "bash", input: { command: "curl https://example.com" } })).toBeUndefined();
	});
});

/** The gate reads consent when it is built, so rebuild it over the same dirs after persisting. */
function captureAfterConsent(cwd: string, home: string) {
	return buildGateHarness.rebuild(cwd, home);
}

describe("permissionGateFactory — what the bridge call carries (SUBAGENT-REVIEW M5)", () => {
	it("passes the child's session id and turn signal so the parent can name the agent and dismiss its prompt", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const handler = buildGate({ permissions: {} }, () => async (call) => {
			calls.push({ ...call });
			return undefined;
		});
		const controller = new AbortController();
		const ctx = { cwd: "/tmp/child", signal: controller.signal, sessionManager: { getSessionId: () => "sess-123" } };
		await (handler as unknown as (e: unknown, c: unknown) => Promise<unknown>)({ toolName: "bash", input: { command: "ls" } }, ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ toolName: "bash", cwd: "/tmp/child", sessionId: "sess-123" });
		expect(calls[0].signal).toBe(controller.signal);
	});
});
