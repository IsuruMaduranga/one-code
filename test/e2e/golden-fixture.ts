/**
 * Offline provider for the golden request snapshot (golden-requests.mjs): wraps
 * `globalThis.fetch` like dump-requests.ts, records every model request body to
 * `GOLDEN_DUMP`, and answers it with a canned streaming reply in the provider's
 * own wire format, so a whole pi session runs with no network and no cost.
 *
 * The reply is in the provider's wire format (Anthropic Messages or OpenAI
 * Chat Completions SSE, picked from the URL). When the newest user text says
 * GOLDEN_TOOLS and no tool result has come back yet, the reply makes the
 * scripted calls in TOOL_CALLS (successes, error paths, a command the auto-mode
 * classifier judges, a deferred-tool load), plus a subagent when it also says
 * GOLDEN_AGENT. The auto-mode classifier gets a verdict instead: severity 60
 * at stage 1, so stage 2 runs too, and severity 10 at stage 2, so the call is
 * allowed and the subagent's own requests are recorded. Every other reply is a
 * fixed text shaped like a compaction summary, which serves every turn and
 * side call (session title, compaction) alike. Any other fetch goes to the
 * network as usual.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRAPPED = Symbol.for("one-code.golden-fixture");

const REPLY_TEXT = "<analysis>Golden.</analysis>\n<summary>Golden summary.</summary>";
type ToolCall = { id: string; name: string; input: Record<string, unknown> };

const TOOL_CALLS: ToolCall[] = [
	{ id: "toolu_golden_1", name: "read", input: { path: "README.md" } },
	{ id: "toolu_golden_2", name: "read", input: { path: "missing.md" } },
	{ id: "toolu_golden_3", name: "bash", input: { command: "echo golden" } },
	{ id: "toolu_golden_4", name: "bash", input: { command: "false" } },
	// Writes outside the project, so auto mode asks its classifier (and the
	// classifier reply below allows it; the file is in the run's temp root).
	{ id: "toolu_golden_5", name: "bash", input: { command: "rm -f ../golden-outside.txt" } },
	{ id: "toolu_golden_6", name: "tool_search", input: { query: "select:notebook_edit" } },
];
/** Added when the user text also says GOLDEN_AGENT: a subagent run (blocking only in one-shot modes). */
const AGENT_CALL: ToolCall = { id: "toolu_golden_7", name: "Agent", input: { description: "Golden check", task: "Reply with OK.", subagent_type: "general-purpose" } };

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const STAGE1_VERDICT = "<severity>60</severity>";
const STAGE2_VERDICT = "<thinking>Golden.</thinking>\n<severity>10</severity>";

/** The classifier's verdict for a classifier request, or undefined for any other request. */
function classifierVerdict(raw: string): string | undefined {
	if (!raw.includes("You are a security monitor")) return undefined;
	return raw.includes("Stage 1 does NOT apply user intent") ? STAGE1_VERDICT : STAGE2_VERDICT;
}

function anthropicReply(calls: ToolCall[] | undefined, text: string): string {
	const withTools = calls !== undefined;
	const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const blocks = withTools
		? calls.flatMap((call, index) => [
				{ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } },
				{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } },
				{ type: "content_block_stop", index },
			])
		: [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
				{ type: "content_block_stop", index: 0 },
			];
	return sse([
		{ type: "message_start", message: { id: "msg_golden", type: "message", role: "assistant", model: "golden", content: [], stop_reason: null, stop_sequence: null, usage } },
		...blocks,
		{ type: "message_delta", delta: { stop_reason: withTools ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function chatReply(calls: ToolCall[] | undefined, text: string): string {
	const withTools = calls !== undefined;
	const chunk = (delta: object, finish: string | null, extra: object = {}) =>
		`data: ${JSON.stringify({ id: "golden", object: "chat.completion.chunk", created: 0, model: "golden", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
	const body = withTools
		? calls.map((call, index) =>
				chunk({ role: "assistant", tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, null),
			).join("")
		: chunk({ role: "assistant", content: text }, null);
	const usage = { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
	return `${body}${chunk({}, withTools ? "tool_calls" : "stop", usage)}data: [DONE]\n\n`;
}

/**
 * The scripted calls when the newest user message asks for them and no
 * assistant reply has followed it, else undefined. Mid-conversation `system`
 * messages may sit after it, so the search skips them.
 */
function scriptedCalls(messages: Array<{ role?: string; content?: unknown }>): ToolCall[] | undefined {
	const userAt = messages.findLastIndex((m) => m.role === "user");
	if (userAt < 0) return undefined;
	const text = JSON.stringify(messages[userAt].content);
	if (!text.includes("GOLDEN_TOOLS") || text.includes("tool_result")) return undefined;
	if (messages.slice(userAt + 1).some((m) => m.role === "assistant" || m.role === "tool")) return undefined;
	return text.includes("GOLDEN_AGENT") ? [...TOOL_CALLS, AGENT_CALL] : TOOL_CALLS;
}

export default function goldenFixture(_pi: ExtensionAPI) {
	if ((globalThis.fetch as { [WRAPPED]?: true })[WRAPPED]) return;
	const out = process.env.GOLDEN_DUMP;
	if (!out) throw new Error("golden-fixture: set GOLDEN_DUMP to the file the request bodies go to");
	const original = globalThis.fetch.bind(globalThis);
	const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const raw = init?.body;
		if (typeof raw !== "string") return original(input, init);
		let body: { messages?: unknown };
		try {
			body = JSON.parse(raw);
		} catch {
			return original(input, init);
		}
		if (!Array.isArray(body.messages)) return original(input, init);
		appendFileSync(out, `${JSON.stringify({ url, body })}\n`);
		const anthropic = url.includes("anthropic.com");
		const verdict = classifierVerdict(raw);
		const calls = verdict === undefined ? scriptedCalls(body.messages as Array<{ role?: string; content?: unknown }>) : undefined;
		const text = verdict ?? REPLY_TEXT;
		return new Response(anthropic ? anthropicReply(calls, text) : chatReply(calls, text), {
			status: 200,
			headers: { "content-type": "text/event-stream", ...(anthropic ? { "request-id": "req_golden" } : {}) },
		});
	}) as typeof fetch & { [WRAPPED]?: true };
	wrapped[WRAPPED] = true;
	globalThis.fetch = wrapped;
}
