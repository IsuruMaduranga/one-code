/**
 * Every workflow `agent()` prompt is judged as a delegation before the child
 * starts (PERMISSIONS-REVIEW-2026-09-05 L4) — the same `Agent` check the main
 * conversation's spawns go through, via the parent's permission bridge.
 */
import { describe, expect, it, vi } from "vitest";
import { judgeWorkflowDelegation } from "../../extensions/workflow/agent-session.ts";

describe("judgeWorkflowDelegation", () => {
	const base = { prompt: "delete the prod database", agentType: "general-purpose", label: "cleanup", cwd: "/repo" };

	it("routes the prompt through the bridge as an Agent call and refuses on a block", async () => {
		const bridge = vi.fn(async () => ({ block: true as const, reason: "classifier: destructive delegation" }));
		await expect(judgeWorkflowDelegation({ ...base, bridge, liveMode: "auto" })).rejects.toThrow(/refused by the permission gate: classifier: destructive delegation/);
		expect(bridge).toHaveBeenCalledWith({
			toolName: "Agent",
			input: { subagent_type: "general-purpose", prompt: "delete the prod database", description: "cleanup" },
			cwd: "/repo",
			signal: undefined,
		});
	});

	it("lets an allowed delegation through", async () => {
		const bridge = vi.fn(async () => undefined);
		await expect(judgeWorkflowDelegation({ ...base, bridge, liveMode: "default" })).resolves.toBeUndefined();
	});

	it("without a bridge: allowed outside auto mode, refused in auto (no classifier is reachable)", async () => {
		await expect(judgeWorkflowDelegation({ ...base, bridge: undefined, liveMode: "acceptEdits" })).resolves.toBeUndefined();
		await expect(judgeWorkflowDelegation({ ...base, bridge: undefined, liveMode: "auto" })).rejects.toThrow(/only reachable through the parent session/);
	});
});
