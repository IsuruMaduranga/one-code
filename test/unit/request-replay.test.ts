import { describe, expect, it } from "vitest";
import {
	captureRequest,
	extendPayload,
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
