import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

	it("adds server-side fallback when the model carries allowedFallbackModels (pi puts `fallbacks` in the body)", () => {
		expect(anthropicBetas(false, { forceAdaptiveThinking: true, allowedFallbackModels: [{ model: "x" }] })).toBe(
			"server-side-fallback-2026-07-01,context-management-2025-06-27",
		);
	});

	it("omits server-side fallback when allowedFallbackModels is empty or absent", () => {
		expect(anthropicBetas(false, { forceAdaptiveThinking: true, allowedFallbackModels: [] })).toBe(
			"context-management-2025-06-27",
		);
	});

	it("adds the mid-conversation effort betas when pi inserts per-message output_config", () => {
		expect(anthropicBetas(false, { forceAdaptiveThinking: true, supportsMidConvoEffort: true })).toBe(
			"mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01,context-management-2025-06-27",
		);
	});

	// Our header replaces the one pi computes, so every beta pi-ai can send must
	// be mirrored here or deliberately skipped; a new one otherwise 400s whatever
	// body field it gates (it happened for `fallbacks`, then per-message effort).
	it("accounts for every beta constant the installed pi-ai declares", () => {
		const source = readFileSync(resolve("node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"), "utf8");
		const declared = [...source.matchAll(/const [A-Z_]+_BETA = "([^"]+)"/g)].map((match) => match[1]);
		expect(declared.length).toBeGreaterThan(0);
		// pi sends the tool-changes beta only on its native tool_addition path, which
		// never engages while One Code forces the system prompt (findings §7).
		const skipped = new Set(["mid-conversation-tool-changes-2026-07-01"]);
		const mirrored = new Set(
			anthropicBetas(true, {
				supportsEagerToolInputStreaming: false,
				allowedFallbackModels: [{ model: "x" }],
				supportsMidConvoEffort: true,
			}).split(","),
		);
		expect(declared.filter((beta) => !mirrored.has(beta) && !skipped.has(beta))).toEqual([]);
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
