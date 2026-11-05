/**
 * One Code's workflow wording (profile/workflow/) where the golden snapshot
 * cannot reach it: a background start, a stopped run's report with kept
 * worktrees, the stop reasons, and the script and call problems a one-shot
 * run does not hit. The golden snapshot pins the refusals, a determinism
 * failure and a completed run's report.
 */
import { describe, expect, it } from "vitest";
import { workflow } from "../../profile/workflow/index.ts";

describe("One Code's workflow text", () => {
	it("says a background run's result comes later and must not be predicted", () => {
		const text = workflow.started({ name: "review", resumed: true, runId: "wf_abc123", scriptPath: "/s/script.js" });
		expect(text.startsWith("Workflow **review** resumed in the background.\nrunId: wf_abc123\nscript: /s/script.js\n")).toBe(true);
		expect(text).toContain("do not predict it");
	});

	it("reports a stopped run with its reason, recent progress, the resume hint and kept worktrees", () => {
		const text = workflow.report({
			name: "review",
			runId: "wf_abc123",
			status: "aborted",
			stats: { agents: 2, outputTokens: 40, cost: 0.01 },
			seconds: 7,
			reason: workflow.runStop({ kind: "stopped", by: "command" }),
			progress: ["⏳ a", "✗ b: failed: boom"],
			keptWorktrees: [{ label: "b", path: "/w/b", branch: "wt-b" }],
		});
		expect(text).toBe(
			'Workflow **review** (wf_abc123) aborted — 2 agent(s), 40 output tokens, $0.0100, 7s.\nReason: stopped via /workflows\nRecent progress:\n⏳ a\n✗ b: failed: boom\nCompleted agent calls are journaled; re-invoke the workflow tool with resumeFromRunId: "wf_abc123" to continue from where it stopped.\n\nWorktrees kept with agents\' changes or commits (review or merge them):\n- b: /w/b (branch wt-b)',
		);
		expect(workflow.report({ name: "x", runId: "wf_1", status: "completed", seconds: 0, progress: [], keptWorktrees: [] })).toContain("Result:\n(script returned no value)");
	});

	it("words every stop reason", () => {
		expect(workflow.runStop({ kind: "wallClock", minutes: 60 })).toBe("wall-clock cap reached (60 minutes)");
		expect(workflow.runStop({ kind: "budgetExhausted", total: 5000 })).toBe("Workflow token budget exhausted (5000 output tokens)");
		expect(workflow.runStop({ kind: "workerExited", code: 1 })).toBe("Workflow worker exited before returning a result (code 1)");
		expect(workflow.runStop({ kind: "stopped", by: "session" })).toBe("session ended");
	});

	it("words the script and call problems", () => {
		expect(workflow.scriptProblem({ kind: "hole", path: "meta.phases[1]" })).toBe("`meta.phases[1]` must not be a hole");
		expect(workflow.scriptProblem({ kind: "metaField", field: "phaseTitle" })).toBe("each entry of `meta.phases` needs a `title` string");
		expect(workflow.callProblem({ kind: "modelUnavailable", model: "nope", menu: ["- a", "- b"] })).toBe('agent() model "nope" is not available.\n- a\n- b\nAny exact provider/model-id also resolves.');
		expect(workflow.callProblem({ kind: "expensiveModel", gate: "Too costly." })).toContain("pass allowExpensive: true");
		expect(workflow.callProblem({ kind: "nestedUnknown", name: "x" })).toBe('workflow("x"): no saved workflow with that name');
		expect(workflow.agentFailure({ kind: "noStructuredOutput" })).toBe("subagent never produced structured output");
	});

	it("names an agent's notices, falling back to 'agent' without a label", () => {
		expect(workflow.notice({ kind: "worktreeKept", path: "/w", branch: "b" })).toBe("agent: worktree kept at /w (branch b) with its changes or commits");
		expect(workflow.notice({ kind: "extensionError", label: "scan", event: "tool_call", error: "boom" })).toBe("scan: extension error in tool_call: boom");
	});
});
