import { describe, expect, it } from "vitest";
import { SessionTurnTracker } from "../../extensions/subagents/session-turns.ts";

/** Hand-built AgentSession events (the shapes session.subscribe delivers). */
const toolStart = (toolName: string, args: unknown) => ({ type: "tool_execution_start", toolName, args });
const assistantEnd = (text: string, usage?: unknown, stopReason?: string, errorMessage?: string) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason, errorMessage },
});
const settled = { type: "agent_settled" };

describe("SessionTurnTracker", () => {
	it("tracks a full turn: tool count, usage, final text, and settle", () => {
		const t = new SessionTurnTracker();
		t.beginTurn();
		expect(t.process(toolStart("read", { path: "a.ts" }))).toBe(false);
		expect(t.process(toolStart("bash", { command: "ls" }))).toBe(false);
		expect(t.process(assistantEnd("all done", { output: 12, totalTokens: 20, cost: { total: 0.001 } }))).toBe(false);
		expect(t.process(settled)).toBe(true);

		expect(t.toolCalls).toBe(2);
		expect(t.actions.map((a) => a.toolName)).toEqual(["read", "bash"]);
		expect(t.turnText).toBe("all done");
		expect(t.usage.output).toBe(12);
		expect(t.turnOutcome().output).toBe("all done");
		expect(t.turnOutcome().failed).toBeUndefined();
	});

	it("resets per-turn state on beginTurn but keeps the transcript and cumulative counts", () => {
		const t = new SessionTurnTracker();
		t.beginTurn();
		t.process(toolStart("read", {}));
		t.process(assistantEnd("first"));
		t.process(settled);
		expect(t.transcript).toBe("first");

		t.beginTurn();
		expect(t.turnText).toBe("");
		expect(t.actions).toEqual([]);
		t.process(toolStart("bash", { command: "echo" }));
		t.process(assistantEnd("second"));
		t.process(settled);

		expect(t.toolCalls).toBe(2); // cumulative across turns
		expect(t.transcript).toBe("first\n\n---\n\nsecond");
		expect(t.turnText).toBe("second");
	});

	it("captures a provider error and clears it on a later successful message", () => {
		const t = new SessionTurnTracker();
		t.beginTurn();
		t.process(assistantEnd("", { output: 0 }, "error", "429 rate limited"));
		expect(t.providerError).toBe("429 rate limited");
		const failed = t.turnOutcome();
		expect(failed.failed).toBe(true);
		expect(failed.output).toContain("provider error");

		t.process(assistantEnd("recovered", { output: 3 }));
		expect(t.providerError).toBeUndefined();
	});

	it("ignores non-assistant message_end and unknown events", () => {
		const t = new SessionTurnTracker();
		t.beginTurn();
		expect(t.process({ type: "message_end", message: { role: "user", content: [] } })).toBe(false);
		expect(t.process({ type: "turn_start" })).toBe(false);
		expect(t.toolCalls).toBe(0);
		expect(t.turnText).toBe("");
	});
});

describe("SessionTurnTracker — aborted turns (SUBAGENT-REVIEW M3)", () => {
	it("reports pi's aborted assistant message as terminated, never as the answer", () => {
		const t = new SessionTurnTracker();
		t.beginTurn();
		t.process(toolStart("bash", { command: "sleep 100" }));
		t.process(assistantEnd("I was about to", undefined, "aborted"));
		t.process(settled);
		const outcome = t.turnOutcome();
		expect(outcome.failed).toBe(true);
		expect(outcome.output).toBe("I was about to\n\n[terminated before the turn finished]");
	});

	it("markAborted covers an abort that lands during a tool call (no aborted assistant message)", () => {
		const t = new SessionTurnTracker();
		t.beginTurn();
		t.process(assistantEnd("partial", undefined, "toolUse"));
		t.process(toolStart("bash", { command: "sleep 100" }));
		t.markAborted("terminated: turn hit the wall-clock cap");
		t.process(settled);
		expect(t.turnOutcome()).toMatchObject({ failed: true, output: "partial\n\n[terminated: turn hit the wall-clock cap]" });
	});

	it("an aborted turn with no text says so, and beginTurn clears the flag", () => {
		const t = new SessionTurnTracker();
		t.beginTurn();
		t.markAborted();
		expect(t.turnOutcome()).toMatchObject({ failed: true, output: "Subagent terminated before the turn finished." });
		t.beginTurn();
		t.process(assistantEnd("fresh answer"));
		t.process(settled);
		expect(t.turnOutcome()).toMatchObject({ output: "fresh answer" });
		expect(t.turnOutcome().failed).toBeUndefined();
	});
});
