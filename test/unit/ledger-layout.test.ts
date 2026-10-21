/**
 * The final layout pass (lib/ledger/layout.ts, findings §52): no system
 * message with content stranded before a user message, whoever built the
 * list (lifecycle-grid-hunt round 3: R3-H1, R3-H2).
 */
import { describe, expect, it } from "vitest";
import { settleSystemMessages } from "../../extensions/lib/ledger/layout.ts";
import { validateRequest } from "../../extensions/lib/ledger/validate.ts";
import { captureRequest, extendPayload, forkRequestPayload } from "../../extensions/lib/request-replay.ts";

const api = "anthropic-messages";
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const system = (text: string) => ({ role: "system", content: [{ type: "text", text }] });
const directive = { role: "system", content: [], output_config: { effort: "high" } };
const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
const countdown = system("<total_tokens>9000 tokens left</total_tokens>");
const body = (messages: unknown[]) => ({ model: "claude-opus-5-5", max_tokens: 32000, system: "One Code", tools: [], messages });

describe("settleSystemMessages", () => {
	it("moves the stack's system message past hook context that follows the prompt (R3-H2)", () => {
		const stack = system("<system-reminder>\nDeferred tools: probe_echo\n</system-reminder>");
		const hook = user("SessionStart hook context");
		const out = settleSystemMessages([user("prompt"), stack, hook, directive], api);
		expect(out).toEqual([user("prompt"), hook, stack, directive]);
		expect(validateRequest(body([...out]), api)).toEqual([]);
	});

	it("moves a stranded run to just before the next assistant message", () => {
		const out = settleSystemMessages([user("a"), countdown, user("b"), assistant("1"), user("c")], api);
		expect(out).toEqual([user("a"), user("b"), countdown, assistant("1"), user("c")]);
	});

	it("leaves a valid list as it is, the same array", () => {
		const list = [user("a"), countdown, assistant("1"), toolResult, countdown, directive];
		expect(settleSystemMessages(list, api)).toBe(list);
	});

	it("never moves an element before `from` except the system run that ends the prefix", () => {
		const prefix = [user("a"), assistant("1"), toolResult, countdown, directive];
		const out = settleSystemMessages([...prefix, user("side question")], api, prefix.length);
		expect(out.slice(0, 3)).toEqual(prefix.slice(0, 3));
		expect(out).toEqual([user("a"), assistant("1"), toolResult, directive, user("side question"), countdown]);
	});

	it("touches no other API", () => {
		const list = [user("a"), countdown, user("b")];
		expect(settleSystemMessages(list, "openai-completions")).toBe(list);
	});
});

describe("side calls and forks append after a captured request", () => {
	// A mid-turn request ends in a tool result's countdown and the effort directive.
	const captured = body([user("task"), assistant("calling"), toolResult, countdown, directive]);
	const capture = captureRequest({ api, provider: "anthropic", id: "claude-opus-5-5" }, captured);
	if (!capture) throw new Error("no capture");

	it("a side call's prompt after a mid-turn capture is a valid request (R3-H1)", () => {
		const out = extendPayload(capture, body([user("Summarize the conversation.")]));
		expect(validateRequest(out, api)).toEqual([]);
		expect((out.messages as unknown[]).slice(0, 3)).toEqual(captured.messages.slice(0, 3));
	});

	it("a fork's task after a mid-turn capture is a valid request", () => {
		const out = forkRequestPayload(capture, body([user("fork task")]), new Set());
		expect(validateRequest(out, api)).toEqual([]);
	});

	it("a /btw fork taken while the capture's reply streams keeps every captured element in place", () => {
		// The reply is not on the branch yet, so the fork's tail opens with the side question, not an assistant message.
		const out = forkRequestPayload(capture, body([user("btw Q"), assistant("btw A"), user("fork task")]), new Set());
		expect(validateRequest(out, api)).toEqual([]);
		expect((out.messages as unknown[]).slice(0, captured.messages.length)).toEqual(captured.messages);
		expect((out.messages as unknown[]).slice(captured.messages.length)).toEqual([system("btw Q"), assistant("btw A"), user("fork task")]);
	});
});
