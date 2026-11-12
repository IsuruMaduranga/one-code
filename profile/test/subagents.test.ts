/**
 * One Code's wording for a fork's framing and a subagent's failed or empty
 * outcome (profile/text/subagents/). The base's part is in
 * test/unit/subagents.test.ts.
 */
import { describe, expect, it } from "vitest";
import { forkTaskMessage } from "../../extensions/agents/subagents/outcome.ts";
import { finishOutcome } from "../../extensions/agents/subagents/session-turns.ts";
import { emptyUsage } from "../../extensions/lib/agents/usage.ts";

describe("One Code's fork framing", () => {
	it("frames the task with do-only-this and not-the-inherited-topic instructions", () => {
		const framed = forkTaskMessage("report exactly: DONE");
		expect(framed).toContain("forked subagent");
		expect(framed).toContain("inherited context");
		expect(framed).toContain("Do ONLY the task below");
		expect(framed).toContain("cannot see the parent's background tasks");
		expect(framed).toContain("the report you hand back through SubagentHandback is returned to the parent conversation verbatim");
		expect(framed).not.toContain("worktree");
		expect(framed.endsWith("Task:\nreport exactly: DONE")).toBe(true);
	});

	it("tells a worktree-isolated fork that its paths moved, and where to write instead", () => {
		const framed = forkTaskMessage("fix the bug", { worktreePath: "/tmp/cc-wt-x/tree", parentCwd: "/Users/me/repo" });
		expect(framed).toContain("your working directory is now /tmp/cc-wt-x/tree");
		expect(framed).toContain("Every path under /Users/me/repo in the inherited context refers to the shared checkout");
		expect(framed).toContain("must NOT modify");
		expect(framed.endsWith("Task:\nfix the bug")).toBe(true);
	});
});

describe("One Code's subagent outcome text", () => {
	it("surfaces a provider error instead of 'produced no output'", () => {
		const outcome = finishOutcome("", "OpenAI API error (401): CreditsError", 0, emptyUsage(), []);
		expect(outcome.output).toContain("provider error");
		expect(outcome.output).toContain("CreditsError");
		expect(outcome.output).toContain("not a task failure");
	});

	it("appends the error to partial text, and says when nothing came back", () => {
		const partial = finishOutcome("halfway report", "rate limited", 2, emptyUsage(), []);
		expect(partial.output).toContain("halfway report");
		expect(partial.output).toContain("rate limited");
		expect(finishOutcome("", undefined, 2, emptyUsage(), []).output).toBe("(Subagent completed but returned no output.)");
	});

	it("says a turn was cut short, with or without partial text", () => {
		expect(finishOutcome("halfway", undefined, 1, emptyUsage(), [], "stopped").output).toBe("halfway\n\n[terminated before the turn finished]");
		expect(finishOutcome("", "rate limited", 0, emptyUsage(), [], "stopped").output).toBe("Subagent terminated before the turn finished.");
		expect(finishOutcome("partial", undefined, 1, emptyUsage(), [], "wallClock").output).toBe("partial\n\n[terminated: turn hit the wall-clock cap]");
	});
});
