import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveModelTier, tierOverride } from "../../extensions/lib/model-tier.ts";

/** Minimal fake — resolveModelTier only reads id/provider/cost. */
function model(id: string, provider: string, inputCost?: number): Model<Api> {
	return { id, provider, cost: inputCost === undefined ? undefined : { input: inputCost } } as unknown as Model<Api>;
}
const noEnv = {} as NodeJS.ProcessEnv;

describe("resolveModelTier", () => {
	it("classifies Anthropic Opus/Fable ≥4.8 and Sonnet ≥5 as frontier", () => {
		for (const id of ["claude-opus-4-8", "claude-opus-5", "claude-fable-5", "claude-sonnet-5"]) {
			expect(resolveModelTier(model(id, "anthropic"), noEnv)).toBe("frontier");
		}
	});

	it("does not read a dated suffix as the minor version", () => {
		expect(resolveModelTier(model("claude-opus-4-8-20251101", "anthropic"), noEnv)).toBe("frontier");
	});

	it("keeps older/other first-party Anthropic models in mid", () => {
		for (const id of ["claude-opus-4-1", "claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
			expect(resolveModelTier(model(id, "anthropic"), noEnv)).toBe("mid");
		}
	});

	it("puts capable non-Anthropic models in mid", () => {
		expect(resolveModelTier(model("gpt-5", "openai", 1.25), noEnv)).toBe("mid");
		expect(resolveModelTier(model("grok-4.5", "xai", 2), noEnv)).toBe("mid");
		expect(resolveModelTier(model("gpt-5.6-luna", "openai", 1), noEnv)).toBe("mid");
	});

	it("puts small/cheap/unpriced non-Anthropic models in low", () => {
		expect(resolveModelTier(model("gemini-2.5-flash", "google", 0.3), noEnv)).toBe("low"); // name hint
		expect(resolveModelTier(model("gpt-5-mini", "openai", 0.25), noEnv)).toBe("low"); // name + price
		expect(resolveModelTier(model("qwen3-32b", "groq", 0.29), noEnv)).toBe("low"); // cheap price, no hint
		expect(resolveModelTier(model("glm-5", "zai", 0), noEnv)).toBe("low"); // unpriced (0 is not priced)
		expect(resolveModelTier(model("some-model", "ollama"), noEnv)).toBe("low"); // opaque local provider
	});

	it("keeps a cheap or unpriced 'pro'-class flagship in mid", () => {
		expect(resolveModelTier(model("deepseek-v4-pro", "deepseek", 0.435), noEnv)).toBe("mid");
		expect(resolveModelTier(model("gemini-3-pro-preview", "google", 2), noEnv)).toBe("mid");
		expect(resolveModelTier(model("some-model-pro", "acme"), noEnv)).toBe("mid"); // unpriced but pro
	});

	it("matches 'pro' only as a delimited token, not a substring", () => {
		// deepseek is a direct (non-opaque) provider and 0.1 < threshold, so the only
		// thing that could wrongly rescue "prometheus" to mid is a substring "pro" match.
		expect(resolveModelTier(model("prometheus-8b", "deepseek", 0.1), noEnv)).toBe("low");
	});

	it("does not demote a gateway-proxied Sonnet on its name alone", () => {
		// openrouter → family (not opaque), no low name-hint (sonnet excluded), priced ≥ threshold → mid
		expect(resolveModelTier(model("anthropic/claude-sonnet-5", "openrouter", 3), noEnv)).toBe("mid");
	});

	it("classifies an unknown model as low (maximum scaffolding)", () => {
		expect(resolveModelTier(undefined, noEnv)).toBe("low");
	});

	it("honors the CC_PROMPT_TIER override over classification", () => {
		const env = (v: string) => ({ CC_PROMPT_TIER: v }) as unknown as NodeJS.ProcessEnv;
		expect(resolveModelTier(model("claude-opus-5", "anthropic"), env("mid"))).toBe("mid");
		expect(resolveModelTier(undefined, env("frontier"))).toBe("frontier");
		expect(resolveModelTier(model("gpt-5-mini", "openai", 0.25), env("frontier"))).toBe("frontier");
		// unrecognized value falls through to classification
		expect(resolveModelTier(model("claude-opus-5", "anthropic"), env("auto"))).toBe("frontier");
	});
});

describe("tierOverride", () => {
	it("parses valid tiers case-insensitively and ignores the rest", () => {
		expect(tierOverride({ CC_PROMPT_TIER: "LOW" } as unknown as NodeJS.ProcessEnv)).toBe("low");
		expect(tierOverride({ CC_PROMPT_TIER: "auto" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
		expect(tierOverride({} as NodeJS.ProcessEnv)).toBeUndefined();
	});
});
