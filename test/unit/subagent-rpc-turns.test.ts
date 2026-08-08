import { describe, expect, it } from "vitest";
import { RpcTurnTracker, toMainMessage } from "../../extensions/subagents/rpc-turns.ts";

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

	it("extracts a child's send_message {to: main} from its tool_execution_end", () => {
		const event = {
			type: "tool_execution_end",
			toolName: "send_message",
			result: { details: { toMain: true, message: "halfway there", summary: "progress" } },
		};
		expect(toMainMessage(event)).toEqual({ message: "halfway there", summary: "progress" });
		const tracker = new RpcTurnTracker();
		expect(tracker.process(JSON.stringify(event))).toEqual({ kind: "message_to_main", message: "halfway there", summary: "progress" });

		// A normal send_message between agents (no toMain) is not relayed.
		expect(toMainMessage({ type: "tool_execution_end", toolName: "send_message", result: { details: { message: "x" } } })).toBeUndefined();
		expect(toMainMessage({ type: "tool_execution_end", toolName: "bash", result: { details: { toMain: true, message: "x" } } })).toBeUndefined();
	});

	it("ignores responses, blank lines, garbage, and non-assistant messages", () => {
		const tracker = new RpcTurnTracker();
		expect(tracker.process("")).toBeUndefined();
		expect(tracker.process("not json")).toBeUndefined();
		expect(tracker.process(JSON.stringify({ type: "response", command: "prompt", success: true }))).toBeUndefined();
		expect(tracker.process(JSON.stringify({ type: "message_end", message: { role: "toolResult" } }))).toBeUndefined();
	});
});

describe("provider errors in the event stream", () => {
	const errorEnd = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage: "OpenAI API error (401): CreditsError" },
	});
	const okEnd = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
	});

	it("captures the error from an assistant message with stopReason error", () => {
		const tracker = new RpcTurnTracker();
		tracker.beginTurn();
		tracker.process(errorEnd);
		expect(tracker.providerError).toBe("OpenAI API error (401): CreditsError");
	});

	it("clears the error when a later assistant message succeeds (pi retried)", () => {
		const tracker = new RpcTurnTracker();
		tracker.beginTurn();
		tracker.process(errorEnd);
		tracker.process(okEnd);
		expect(tracker.providerError).toBeUndefined();
		expect(tracker.turnText).toBe("done");
	});

	it("resets the error on a new turn", () => {
		const tracker = new RpcTurnTracker();
		tracker.beginTurn();
		tracker.process(errorEnd);
		tracker.beginTurn();
		expect(tracker.providerError).toBeUndefined();
	});
});
