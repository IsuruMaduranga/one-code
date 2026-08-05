import { describe, expect, it } from "vitest";
import {
	anthropicBetas,
	clearThinkingApplies,
	clearThinkingEnabled,
	looksLikeAnthropicRequest,
	withClearThinking,
} from "../../extensions/context-management/index.ts";

describe("clearThinkingEnabled", () => {
	const firstParty = { api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com" };
	const proxy = { api: "anthropic-messages", provider: "my-proxy", baseUrl: "https://llm.corp.example" };

	it("defaults on for first-party Anthropic", () => {
		expect(clearThinkingEnabled(undefined, firstParty)).toBe(true);
	});

	it("defaults off for other anthropic-messages endpoints (Bedrock, proxies)", () => {
		expect(clearThinkingEnabled(undefined, proxy)).toBe(false);
	});

	it("never applies to non-anthropic-messages APIs, even when forced", () => {
		expect(clearThinkingEnabled("1", { api: "openai-responses", provider: "openai" })).toBe(false);
		expect(clearThinkingEnabled("1", undefined)).toBe(false);
	});

	it("CC_CLEAR_THINKING=1 forces on for a confirmed proxy", () => {
		expect(clearThinkingEnabled("1", proxy)).toBe(true);
	});

	it("CC_CLEAR_THINKING=0 forces off everywhere", () => {
		expect(clearThinkingEnabled("0", firstParty)).toBe(false);
	});
});

describe("anthropicBetas", () => {
	it("appends context-management to pi's interleaved-thinking beta for non-adaptive models", () => {
		expect(anthropicBetas(false, {})).toBe("interleaved-thinking-2025-05-14,context-management-2025-06-27");
	});

	it("sends only context-management for adaptive models (pi sends no betas there)", () => {
		expect(anthropicBetas(false, { forceAdaptiveThinking: true })).toBe("context-management-2025-06-27");
	});

	it("keeps the OAuth identity betas first", () => {
		expect(anthropicBetas(true, { forceAdaptiveThinking: true })).toBe(
			"claude-code-20250219,oauth-2025-04-20,context-management-2025-06-27",
		);
	});

	it("includes fine-grained streaming when the model lacks eager input streaming", () => {
		expect(anthropicBetas(false, { supportsEagerToolInputStreaming: false, forceAdaptiveThinking: true })).toBe(
			"fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27",
		);
	});
});

describe("clearThinkingApplies", () => {
	it("applies when the payload has thinking enabled", () => {
		expect(clearThinkingApplies({ thinking: { type: "enabled" } }, false)).toBe(true);
	});
	it("applies on adaptive models regardless of a thinking param", () => {
		expect(clearThinkingApplies({}, true)).toBe(true);
	});
	it("does not apply without either (the API rejects the edit)", () => {
		expect(clearThinkingApplies({}, false)).toBe(false);
	});
});

describe("withClearThinking", () => {
	it("adds the edit once and keeps existing edits", () => {
		const payload = { model: "claude-x", messages: [], context_management: { edits: [{ type: "other" }] } };
		const out = withClearThinking(payload) as { context_management: { edits: { type: string }[] } };
		expect(out.context_management.edits.map((e) => e.type)).toEqual(["other", "clear_thinking_20251015"]);
		expect(withClearThinking(out as never)).toBe(out);
	});
});

describe("looksLikeAnthropicRequest", () => {
	it("matches a messages+claude payload and rejects OpenAI input shape", () => {
		expect(looksLikeAnthropicRequest({ model: "claude-haiku-4-5", messages: [] })).toBe(true);
		expect(looksLikeAnthropicRequest({ model: "gpt-5.5", input: [], messages: [] })).toBe(false);
	});
});
