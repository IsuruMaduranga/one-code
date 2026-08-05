import { describe, expect, it } from "vitest";
import { RpcTurnTracker } from "../../extensions/subagents/rpc-turns.ts";

const assistantEnd = (text: string, usage?: Record<string, unknown>) =>
	JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } });

describe("RpcTurnTracker", () => {
	it("tracks a full turn: tools, usage, text, and turn_end", () => {
		const tracker = new RpcTurnTracker();
		tracker.beginTurn();
		expect(tracker.busy).toBe(true);
		expect(tracker.process(JSON.stringify({ type: "tool_execution_start" }))?.kind).toBe("progress");
		expect(tracker.process(assistantEnd("hello", { input: 100, output: 5, totalTokens: 105, cost: { total: 0.01 } }))?.kind).toBe("progress");
		expect(tracker.process(JSON.stringify({ type: "agent_end" }))?.kind).toBe("turn_end");
		expect(tracker.busy).toBe(false);
		expect(tracker.toolCalls).toBe(1);
		expect(tracker.turnText).toBe("hello");
		expect(tracker.usage.total).toBe(105);
	});

	it("resets turn text per turn but keeps a cumulative transcript and stats", () => {
		const tracker = new RpcTurnTracker();
		tracker.beginTurn();
		tracker.process(assistantEnd("first"));
		tracker.process(JSON.stringify({ type: "agent_end" }));
		tracker.beginTurn();
		expect(tracker.turnText).toBe("");
		tracker.process(assistantEnd("second"));
		tracker.process(JSON.stringify({ type: "agent_end" }));
		expect(tracker.turnText).toBe("second");
		expect(tracker.transcript).toBe("first\n\n---\n\nsecond");
	});

	it("distinguishes busy (prompt sent) from streaming (child's loop running)", () => {
		const tracker = new RpcTurnTracker();
		tracker.beginTurn();
		expect(tracker.busy).toBe(true);
		expect(tracker.streaming).toBe(false); // child still booting — steers must wait
		expect(tracker.process(JSON.stringify({ type: "agent_start" }))?.kind).toBe("stream_start");
		expect(tracker.streaming).toBe(true);
		tracker.process(JSON.stringify({ type: "agent_end" }));
		expect(tracker.streaming).toBe(false);
		expect(tracker.busy).toBe(false);
	});

	it("surfaces extension_ui_request ids so the caller can cancel them", () => {
		const tracker = new RpcTurnTracker();
		const action = tracker.process(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select" }));
		expect(action).toEqual({ kind: "ui_request", id: "ui-1" });
	});

	it("ignores responses, blank lines, garbage, and non-assistant messages", () => {
		const tracker = new RpcTurnTracker();
		expect(tracker.process("")).toBeUndefined();
		expect(tracker.process("not json")).toBeUndefined();
		expect(tracker.process(JSON.stringify({ type: "response", command: "prompt", success: true }))).toBeUndefined();
		expect(tracker.process(JSON.stringify({ type: "message_end", message: { role: "toolResult" } }))).toBeUndefined();
	});
});
