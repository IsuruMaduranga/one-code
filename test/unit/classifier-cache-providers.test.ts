/**
 * The classifier's and the side calls' cache breakpoints on the payloads
 * pi-ai's own adapters build, offline (each hook throws before dispatch):
 * OpenRouter's Anthropic-format Chat Completions, Bedrock Converse on Claude,
 * OpenAI Responses on a model that takes explicit breakpoints, and plain Chat
 * Completions, which carries no marker and is left alone.
 */
import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { stream as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { cacheClassifierHistory } from "../../extensions/safety/permissions/auto-mode/cache.ts";
import { cacheSideCallConversation } from "../../extensions/lib/side-calls/side-call-cache.ts";

const base = { reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const openrouterClaude = { ...base, id: "anthropic/claude-sonnet-5", name: "Claude via OpenRouter", api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } as Model<"openai-completions">;
const openrouterOther = { ...openrouterClaude, id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek via OpenRouter" } as Model<"openai-completions">;
const bedrockClaude = { ...base, id: "us.anthropic.claude-sonnet-5-v1:0", name: "Claude on Bedrock", api: "bedrock-converse-stream", provider: "amazon-bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" } as Model<"bedrock-converse-stream">;
const openaiTerra = { ...base, reasoning: true, id: "gpt-6.1-terra", name: "GPT-6.1 Terra", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", compat: { supportsExplicitPromptCacheMode: true } } as Model<"openai-responses">;
const openaiOlder = { ...openaiTerra, id: "gpt-5.5", name: "GPT-5.5", compat: {} } as Model<"openai-responses">;

type Wire = Record<string, any>;

/** The payload pi-ai builds for `messages`, after `edit`, captured before any network. */
async function payloadOf(model: Model<any>, systemPrompt: string, messages: unknown[], edit: (payload: unknown) => void, apiKey = "offline-key"): Promise<Wire> {
	let payload: Wire | undefined;
	const fetch = vi.fn(async () => { throw new Error("No network in this test"); });
	const run = model.api === "bedrock-converse-stream" ? bedrockStream : model.api === "openai-responses" ? responsesStream : completionsStream;
	const result = await run(model as never, normalizeContext({ systemPrompt, messages: messages as never[] }), {
		apiKey, sessionId: "offline-session:auto-mode", cacheRetention: "long", fetch, maxRetries: 0,
		env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "offline", AWS_SECRET_ACCESS_KEY: "offline" },
		onPayload: (value: unknown) => {
			edit(value);
			payload = value as Wire;
			throw new Error("Captured before dispatch");
		},
	} as never).result();
	expect(result.errorMessage).toContain("Captured before dispatch");
	expect(fetch).not.toHaveBeenCalled();
	return payload!;
}

const parts = ["<transcript>", '\n{"user":"Check the public sites."}', '\n{"Bash":"curl -sI https://example.com"}', '\n{"Bash":"curl https://example.com"}\n</transcript>', "\n\nStage instruction."];
const historyEnd = 2;
const classifierCall = (model: Model<any>, previousEnd?: number, apiKey?: string) =>
	payloadOf(model, "Classifier ruleset", [{ role: "user", content: parts.join(""), timestamp: 1 }], (payload) => cacheClassifierHistory(payload, parts, historyEnd, previousEnd), apiKey);
const markers = (value: unknown): number =>
	Array.isArray(value) ? value.reduce((sum: number, entry) => sum + markers(entry), 0)
	: value && typeof value === "object" ? ("cache_control" in value || "cachePoint" in value ? 1 : 0) + Object.entries(value).reduce((sum, [key, entry]) => sum + (key === "cache_control" || key === "cachePoint" ? 0 : markers(entry)), 0)
	: 0;

describe("classifier history breakpoints", () => {
	it("marks the reusable history, not the action, on OpenRouter's Anthropic format", async () => {
		const payload = await classifierCall(openrouterClaude, 1);
		const user = payload.messages.find((message: Wire) => message.role === "user");
		expect(user.content.map((block: Wire) => block.text).join("")).toBe(parts.join(""));
		const marked = user.content.flatMap((block: Wire, i: number) => (block.cache_control ? [i] : []));
		expect(marked).toEqual([1, historyEnd]);
		expect(user.content[historyEnd].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(markers(payload)).toBeLessThanOrEqual(4);
	});

	it("puts cache points after the history on Bedrock Claude", async () => {
		const payload = await classifierCall(bedrockClaude, 1);
		const content = payload.messages[0].content as Wire[];
		expect(content.filter((block) => "text" in block).map((block) => block.text).join("")).toBe(parts.join(""));
		const points = content.flatMap((block, i) => ("cachePoint" in block ? [i] : []));
		// Each point follows the text block it closes: entries 1 and 2.
		expect(points.map((i) => content[i - 1].text)).toEqual([parts[1], parts[historyEnd]]);
		expect(content.at(-1)).toEqual({ text: parts.at(-1) });
		expect(markers(payload)).toBeLessThanOrEqual(4);
	});

	it("marks the history with explicit breakpoints on OpenAI Responses", async () => {
		const payload = await classifierCall(openaiTerra, 1, "sk-offline");
		expect(payload.prompt_cache_options).toEqual({ ttl: "30m" });
		expect(payload.input[0]).toEqual({ role: "developer", content: "Classifier ruleset" });
		const content = payload.input.find((item: Wire) => item.role === "user").content as Wire[];
		expect(content.map((part) => part.text).join("")).toBe(parts.join(""));
		expect(content.every((part) => part.type === "input_text" && part.text !== "")).toBe(true);
		expect(content.flatMap((part, i) => (part.prompt_cache_breakpoint ? [i] : []))).toEqual([0, 1, historyEnd]);
		expect(content[historyEnd].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
	});

	// An older model gets no prompt_cache_options, and a ChatGPT sign-in (a key
	// without the `sk-` prefix) has them left off because it rejects them.
	it.each([["a model without explicit breakpoints", openaiOlder, "sk-offline"], ["a ChatGPT sign-in", openaiTerra, "offline-token"]] as const)("leaves OpenAI Responses as pi-ai built it on %s", async (_label, model, apiKey) => {
		const payload = await classifierCall(model, 1, apiKey);
		expect(payload.prompt_cache_options).toBeUndefined();
		const user = payload.input.find((item: Wire) => item.role === "user");
		expect(user.content).toEqual([{ type: "input_text", text: parts.join("") }]);
	});

	it("leaves a Chat Completions payload without markers as pi-ai built it", async () => {
		const payload = await classifierCall(openrouterOther, 1);
		const user = payload.messages.find((message: Wire) => message.role === "user");
		expect(user.content).toBe(parts.join(""));
	});
});

const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });
const assistant = (content: unknown[], timestamp: number, stopReason = "stop") => ({
	role: "assistant" as const, content, api: "openai-completions", provider: "openrouter", model: openrouterClaude.id, usage: {}, stopReason, timestamp,
});

describe("standalone side-call breakpoints on OpenRouter's Anthropic format", () => {
	it("moves the question's marker onto the conversation before it", async () => {
		const payload = await payloadOf(openrouterClaude, "", [
			user("Initial user", 1),
			assistant([{ type: "text", text: "Assistant answer" }], 2),
			user("Side question", 3),
		], cacheSideCallConversation);
		const [first, reply, question] = payload.messages.filter((message: Wire) => message.role !== "system");
		expect(first.content).toBe("Initial user");
		expect(reply.content).toEqual([{ type: "text", text: "Assistant answer", cache_control: { type: "ephemeral", ttl: "1h" } }]);
		expect(question.content).toEqual([{ type: "text", text: "Side question" }]);
	});

	it("skips a tool-call-only reply for the tool result before the question", async () => {
		const payload = await payloadOf(openrouterClaude, "", [
			user("Initial user", 1),
			assistant([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }], 2, "toolUse"),
			{ role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "File bytes" }], isError: false, timestamp: 3 },
			user("Side question", 4),
		], cacheSideCallConversation);
		const tool = payload.messages.find((message: Wire) => message.role === "tool");
		expect(tool.content).toEqual([{ type: "text", text: "File bytes", cache_control: { type: "ephemeral", ttl: "1h" } }]);
		expect(markers(payload.messages.at(-1))).toBe(0);
		expect(markers(payload)).toBeLessThanOrEqual(4);
	});
});
