import { describe, expect, it } from "vitest";
import {
	affinityHeaders,
	captureMatches,
	captureRequest,
	extendPayload,
	forkOutputRoom,
	forkRequestPayload,
	lastCovered,
	toolNames,
	uncoveredMessages,
	LastExchange,
	MIN_REPLAY_OUTPUT_TOKENS,
	type RequestCapture,
	replayOutputCap,
	replayTail,
} from "../../extensions/lib/request-replay.ts";

const anthropic = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5" };
const marker = { type: "ephemeral", ttl: "1h" };

function anthropicCapture(): RequestCapture {
	const capture = captureRequest(anthropic, {
		model: "claude-sonnet-5",
		system: [{ type: "text", text: "prompt", cache_control: marker }],
		tools: [{ name: "read", cache_control: marker }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: [{ type: "text", text: "read it", cache_control: marker }] },
		],
		max_tokens: 64000,
		thinking: { type: "adaptive" },
	});
	if (!capture) throw new Error("expected a capture");
	return capture;
}

function markers(value: unknown): number {
	return (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;
}

describe("captureRequest", () => {
	it("captures the three appendable APIs and nothing else", () => {
		expect(captureRequest(anthropic, { messages: [] })?.api).toBe("anthropic-messages");
		expect(captureRequest({ ...anthropic, api: "openai-completions" }, { messages: [] })?.api).toBe("openai-completions");
		expect(captureRequest({ ...anthropic, api: "openai-responses" }, { input: [] })?.api).toBe("openai-responses");
		expect(captureRequest({ ...anthropic, api: "google-generative-ai" }, { contents: [] })).toBeUndefined();
		expect(captureRequest({ ...anthropic, api: "openai-responses" }, { messages: [] })).toBeUndefined();
		expect(captureRequest(undefined, { messages: [] })).toBeUndefined();
	});
});

describe("LastExchange", () => {
	const capture = anthropicCapture();
	const reply = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };

	it("pairs the capture with the clean reply that answered it, for the same model only", () => {
		const exchange = new LastExchange();
		exchange.setCapture(capture);
		exchange.noteMessage(reply);
		expect(exchange.forModel(anthropic)).toEqual({ capture, reply });
		expect(exchange.forModel({ ...anthropic, id: "claude-opus-5-5" })).toBeUndefined();
	});

	it("drops a reply that errored, was aborted or still waits on tool results", () => {
		for (const bad of [
			{ ...reply, stopReason: "error" },
			{ ...reply, stopReason: "aborted" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1" }], stopReason: "toolUse" },
		]) {
			const exchange = new LastExchange();
			exchange.setCapture(capture);
			exchange.noteMessage(reply);
			exchange.noteMessage(bad);
			expect(exchange.forModel(anthropic)?.reply).toBeUndefined();
		}
	});

	it("forgets the reply when a new request is captured, and everything on undefined", () => {
		const exchange = new LastExchange();
		exchange.setCapture(capture);
		exchange.noteMessage(reply);
		exchange.setCapture(capture);
		expect(exchange.forModel(anthropic)?.reply).toBeUndefined();
		exchange.setCapture(undefined);
		expect(exchange.forModel(anthropic)).toBeUndefined();
	});
});

describe("extendPayload (Anthropic)", () => {
	it("keeps every captured field, moves the conversation marker onto the reply and leaves the prompt unmarked", () => {
		const capture = anthropicCapture();
		const tail = {
			messages: [
				{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "done" }] },
				{ role: "user", content: [{ type: "text", text: "recap", cache_control: { type: "ephemeral" } }] },
			],
			system: [{ type: "text", text: "ignored" }],
		};
		const out = extendPayload(capture, tail, 5000);
		const messages = out.messages as { role: string; content: Record<string, unknown>[] }[];
		expect(out.system).toBe(capture.payload.system);
		expect(out.tools).toBe(capture.payload.tools);
		expect(out.thinking).toBe(capture.payload.thinking);
		expect(out.max_tokens).toBe(5000);
		expect(messages).toHaveLength(5);
		expect(messages.slice(0, 2)).toEqual((capture.payload.messages as unknown[]).slice(0, 2));
		expect(messages[2].content[0].cache_control).toBeUndefined();
		expect(messages[3].content[1].cache_control).toEqual(marker);
		expect(messages[3].content[0].cache_control).toBeUndefined();
		expect(messages[4].content[0].cache_control).toBeUndefined();
		expect(markers(out)).toBe(markers(capture.payload));
		// The capture itself is never mutated.
		expect((capture.payload.messages as { content: Record<string, unknown>[] }[])[2].content[0].cache_control).toEqual(marker);
	});

	it("merges a prompt-only tail into a trailing user message so the roles alternate", () => {
		const capture = anthropicCapture();
		const out = extendPayload(capture, { messages: [{ role: "user", content: [{ type: "text", text: "btw?" }] }] });
		const messages = out.messages as { role: string; content: Record<string, unknown>[] }[];
		expect(messages).toHaveLength(3);
		expect(messages[2].content.map((block) => block.text)).toEqual(["read it", "btw?"]);
		expect(messages[2].content[0].cache_control).toEqual(marker);
		expect(out.max_tokens).toBe(64000);
	});
});

describe("extendPayload (OpenAI-style)", () => {
	it("appends to `messages` on Completions and writes the cap to the field the body uses", () => {
		const capture = captureRequest(
			{ ...anthropic, api: "openai-completions" },
			{ messages: [{ role: "system", content: "p" }, { role: "user", content: "hi" }], max_completion_tokens: 32000 },
		)!;
		const out = extendPayload(capture, { messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }] }, 4000);
		expect(out.messages).toEqual([
			{ role: "system", content: "p" },
			{ role: "user", content: "hi" },
			{ role: "user", content: [{ type: "text", text: "q" }] },
		]);
		expect(out.max_completion_tokens).toBe(4000);
		expect(out.max_tokens).toBeUndefined();
	});

	it("appends to `input` on Responses", () => {
		const capture = captureRequest({ ...anthropic, api: "openai-responses" }, { input: [{ role: "user", content: "hi" }], prompt_cache_key: "k" })!;
		const out = extendPayload(capture, { input: [{ role: "user", content: "q" }], instructions: "ignored" }, 4000);
		expect(out.input).toEqual([{ role: "user", content: "hi" }, { role: "user", content: "q" }]);
		expect(out.prompt_cache_key).toBe("k");
		expect(out.instructions).toBeUndefined();
		expect(out.max_output_tokens).toBe(4000);
	});
});

describe("replayTail / replayOutputCap", () => {
	const reply = { role: "assistant", content: [{ type: "text", text: "done" }] } as never;

	it("puts the reply before the prompt", () => {
		expect(replayTail(reply, "q", 1).map((m) => m.role)).toEqual(["assistant", "user"]);
		expect(replayTail(undefined, "q", 1)).toEqual([{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 }]);
	});

	it("puts a side session's earlier exchanges between the reply and the prompt", () => {
		const earlier = [
			{ role: "user", content: [{ type: "text", text: "a" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "1" }] },
		] as never[];
		expect(replayTail(reply, "q", 1, earlier).map((m) => m.role)).toEqual(["assistant", "user", "assistant", "user"]);
		expect(replayTail(undefined, "q", 1, earlier)[0]).toBe(earlier[0]);
	});

	it("spends the captured cap on the tail, honours a limit, and refuses when too little is left", () => {
		const capture = anthropicCapture();
		const tail = replayTail(undefined, "x".repeat(400), 1);
		const cap = replayOutputCap(capture, tail);
		expect(cap).toBeLessThan(64000);
		expect(cap).toBeGreaterThan(63000);
		expect(replayOutputCap(capture, tail, 8000)).toBe(8000);
		const tight = { ...capture, payload: { ...capture.payload, max_tokens: MIN_REPLAY_OUTPUT_TOKENS + 10 } };
		expect(replayOutputCap(tight, tail)).toBeUndefined();
	});
});

describe("forks: the parent's captured request, then the fork's own tail", () => {
	const covers = { role: "user", timestamp: 30 };
	const withCovers = (capture: RequestCapture): RequestCapture => ({ ...capture, covers });

	it("lastCovered names the last non-system message; captureMatches needs the same api, provider and model", () => {
		expect(lastCovered([{ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 2 }, { role: "system", timestamp: 3 }])).toEqual({ role: "assistant", timestamp: 2 });
		expect(lastCovered([{ role: "user" }])).toBeUndefined();
		expect(captureRequest(anthropic, { messages: [] }, covers)?.covers).toEqual(covers);
		const capture = anthropicCapture();
		expect(captureMatches(capture, anthropic)).toBe(true);
		expect(captureMatches(capture, { ...anthropic, id: "claude-opus-5-5" })).toBe(false);
		expect(captureMatches(capture, { ...anthropic, api: "openai-completions" })).toBe(false);
	});

	it("uncoveredMessages drops everything through the boundary but the system messages, or finds nothing", () => {
		const messages = [
			{ role: "system", timestamp: 0 },
			{ role: "user", timestamp: 10 },
			{ role: "assistant", timestamp: 20 },
			{ role: "user", timestamp: 30 },
			{ role: "assistant", timestamp: 40 },
			{ role: "user", timestamp: 50 },
		];
		expect(uncoveredMessages(messages, covers)).toEqual([messages[0], messages[4], messages[5]]);
		expect(uncoveredMessages(messages, { role: "assistant", timestamp: 30 })).toBeUndefined();
		expect(uncoveredMessages(messages.slice(4), covers)).toBeUndefined();
	});

	it("keeps the parent's system, tools, messages and fields byte for byte and appends the tail (Anthropic)", () => {
		const capture = withCovers(anthropicCapture());
		const child = {
			model: "claude-sonnet-5",
			system: [{ type: "text", text: "the fork's own prompt", cache_control: marker }],
			tools: [{ name: "read" }, { name: "SendMessage", cache_control: marker }],
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
				{ role: "user", content: [{ type: "text", text: "fork task", cache_control: marker }] },
			],
			max_tokens: 128000,
			thinking: { type: "enabled" },
		};
		const out = forkRequestPayload(capture, child, new Set(toolNames(child.tools)));
		expect(out.system).toBe(capture.payload.system);
		expect(out.tools).toBe(capture.payload.tools);
		expect(out.thinking).toBe(capture.payload.thinking);
		const messages = out.messages as unknown[];
		expect(messages.slice(0, 3)).toEqual((capture.payload.messages as unknown[]).slice(0, 3));
		expect(messages.slice(3)).toEqual(child.messages);
		// The parent's cap less the tail, never the fork's larger one.
		expect(out.max_tokens).toBeLessThan(64000);
		expect(out.max_tokens).toBeGreaterThan(63000);
		expect(markers(out)).toBeLessThanOrEqual(4);
	});

	it("drops the earliest markers past four without touching the shared capture", () => {
		const capture = withCovers(anthropicCapture());
		const system = [
			{ type: "text", text: "a", cache_control: marker },
			{ type: "text", text: "b", cache_control: marker },
		];
		const shared: RequestCapture = { ...capture, payload: { ...capture.payload, system } };
		const child = { messages: [{ role: "assistant", content: [{ type: "text", text: "ok", cache_control: marker }] }] };
		const out = forkRequestPayload(shared, child, new Set());
		// tools 1 + system 2 + parent message 1 + tail 1 = 5: the tools marker goes first.
		expect(markers(out)).toBe(4);
		expect(markers(out.tools)).toBe(0);
		expect(markers(out.system)).toBe(2);
		expect(markers(shared.payload.tools)).toBe(1);
		const messages = out.messages as { content: Record<string, unknown>[] }[];
		expect(messages[2].content[0].cache_control).toEqual(marker);
		expect(messages[3].content[0].cache_control).toEqual(marker);
	});

	it("joins a tail that opens with a user turn onto the captured last user message", () => {
		const capture = withCovers(anthropicCapture());
		const out = forkRequestPayload(capture, { messages: [{ role: "user", content: [{ type: "text", text: "btw q" }] }] }, new Set());
		const messages = out.messages as { role: string; content: Record<string, unknown>[] }[];
		expect(messages).toHaveLength(3);
		expect(messages[2].content.map((block) => block.text)).toEqual(["read it", "btw q"]);
	});

	it("keeps the parent's tools and appends only a tool the fork loaded later or a tool_reference names", () => {
		const capture = withCovers(anthropicCapture());
		const baseline = new Set(["read", "SendMessage", "cron_list"]);
		const later = {
			tools: [{ name: "read" }, { name: "SendMessage" }, { name: "cron_list" }, { name: "mcp__x__y", cache_control: marker }],
			messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
		};
		expect(toolNames(forkRequestPayload(capture, later, baseline).tools)).toEqual(["read", "mcp__x__y"]);
		expect(markers(forkRequestPayload(capture, later, baseline).tools)).toBe(1);
		const referencing = {
			tools: [{ name: "read" }, { name: "cron_list" }],
			messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "tool_reference", tool_name: "cron_list" }] }] }],
		};
		expect(toolNames(forkRequestPayload(capture, referencing, baseline).tools)).toEqual(["read", "cron_list"]);
	});

	it("drops the fork's own system and developer entries on Completions and Responses, keeping prompt_cache_key", () => {
		const completions = captureRequest(
			{ ...anthropic, api: "openai-completions" },
			{ messages: [{ role: "system", content: "parent" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read" } }], prompt_cache_key: "parent-session", max_completion_tokens: 32000 },
			covers,
		) as RequestCapture;
		const out = forkRequestPayload(
			completions,
			{ messages: [{ role: "system", content: "fork" }, { role: "assistant", content: "ok" }, { role: "user", content: "task" }], tools: [{ type: "function", function: { name: "read" } }] },
			new Set(["read"]),
		);
		expect(out.messages).toEqual([{ role: "system", content: "parent" }, { role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "task" }]);
		expect(out.prompt_cache_key).toBe("parent-session");
		expect(out.tools).toBe(completions.payload.tools);
		const responses = captureRequest({ ...anthropic, api: "openai-responses" }, { input: [{ role: "developer", content: "parent" }, { role: "user", content: "hi" }] }, covers) as RequestCapture;
		const outResponses = forkRequestPayload(responses, { input: [{ role: "developer", content: "fork" }, { type: "function_call", name: "read" }] }, new Set());
		expect(outResponses.input).toEqual([{ role: "developer", content: "parent" }, { role: "user", content: "hi" }, { type: "function_call", name: "read" }]);
	});
});

describe("forks: output room", () => {
	it("never raises the cap above what the tail leaves, and reports the room to fall back on", () => {
		const capture = { ...anthropicCapture(), payload: { ...anthropicCapture().payload, max_tokens: 2000 } } as RequestCapture;
		const tail = [{ role: "user", content: [{ type: "text", text: "x".repeat(6000) }] }];
		const room = forkOutputRoom(capture, tail) as number;
		expect(room).toBeLessThan(MIN_REPLAY_OUTPUT_TOKENS);
		const out = forkRequestPayload(capture, { messages: tail, max_tokens: 64000 }, new Set());
		expect(out.max_tokens).toBe(room);
		expect(forkOutputRoom({ ...capture, payload: { messages: [] } }, tail)).toBeUndefined();
		// A tool appended after the first request spends room as well.
		const loaded = { name: "mcp__x__y", description: "d".repeat(2000) };
		const roomy = { ...capture, payload: { ...capture.payload, max_tokens: 8000 } } as RequestCapture;
		const withTool = forkRequestPayload(roomy, { messages: tail, tools: [loaded], max_tokens: 64000 }, new Set());
		expect(withTool.max_tokens).toBe((forkOutputRoom(roomy, tail) as number) - Math.ceil(JSON.stringify([loaded]).length / 4));
	});
});

describe("affinityHeaders: pi-ai's session-affinity headers, for a fork to send its parent's", () => {
	const or = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
	it("OpenRouter routes on x-session-id for every API", () => {
		for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
			expect(affinityHeaders({ ...or, api, id: "m" }, "S")).toEqual({ "x-session-id": "S" });
		}
	});
	it("elsewhere follows pi-ai: Responses always, Completions and Anthropic only when the compat asks", () => {
		expect(affinityHeaders({ api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", id: "m" }, "S")).toEqual({ session_id: "S", "x-client-request-id": "S" });
		expect(affinityHeaders({ api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com", id: "m" }, "S")).toEqual({});
		expect(affinityHeaders({ api: "openai-completions", provider: "x", baseUrl: "https://x", id: "m", compat: { sendSessionAffinityHeaders: true } }, "S")).toEqual({ session_id: "S", "x-client-request-id": "S", "x-session-affinity": "S" });
		expect(affinityHeaders({ api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", id: "m" }, "S")).toEqual({});
		expect(affinityHeaders({ api: "anthropic-messages", provider: "x", baseUrl: "https://x", id: "m", compat: { sendSessionAffinityHeaders: true } }, "S")).toEqual({ "x-session-affinity": "S" });
	});
});
