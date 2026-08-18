import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	economicalContainedCandidates,
	pickEconomicalContainedModel,
	resolveModelTier,
	tierOverride,
} from "../../extensions/lib/model-tier.ts";

/** Minimal fake — resolveModelTier only reads id/provider/cost. */
function model(id: string, provider: string, inputCost?: number): Model<Api> {
	return { id, provider, cost: inputCost === undefined ? undefined : { input: inputCost } } as unknown as Model<Api>;
}
const noEnv = {} as NodeJS.ProcessEnv;

describe("resolveModelTier", () => {
	it("classifies first-party Anthropic Opus/Fable ≥4.7 as frontier", () => {
		for (const id of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-fable-5"]) {
			expect(resolveModelTier(model(id, "anthropic"), noEnv)).toBe("frontier");
		}
	});

	it("does NOT put Sonnet in frontier — it is workhorse", () => {
		expect(resolveModelTier(model("claude-sonnet-5", "anthropic"), noEnv)).toBe("workhorse");
	});

	it("does not read a dated suffix as the minor version", () => {
		expect(resolveModelTier(model("claude-opus-4-8-20251101", "anthropic"), noEnv)).toBe("frontier");
	});

	it("puts Anthropic Haiku in cheap, other non-frontier first-party in workhorse", () => {
		expect(resolveModelTier(model("claude-haiku-4-5", "anthropic"), noEnv)).toBe("cheap");
		for (const id of ["claude-opus-4-1", "claude-opus-4-6", "claude-sonnet-4-6"]) {
			expect(resolveModelTier(model(id, "anthropic"), noEnv)).toBe("workhorse");
		}
	});

	it("puts capable non-Anthropic models in workhorse", () => {
		expect(resolveModelTier(model("gpt-5", "openai", 1.25), noEnv)).toBe("workhorse"); // anchor
		expect(resolveModelTier(model("gpt-5.6-sol", "openai", 4.5), noEnv)).toBe("workhorse"); // anchor
		expect(resolveModelTier(model("grok-4.5", "xai", 2), noEnv)).toBe("workhorse"); // anchor
	});

	it("applies the ratified anchor overrides", () => {
		// GPT-5-mini would price to tiny; the override anchors it at cheap.
		expect(resolveModelTier(model("gpt-5-mini", "openai", 0.25), noEnv)).toBe("cheap");
		// GPT-5.6-Luna is OpenAI's cheap line despite a high benchmark → cheap, not workhorse.
		expect(resolveModelTier(model("gpt-5.6-luna", "openai", 1), noEnv)).toBe("cheap");
		// GPT-5-nano stays tiny.
		expect(resolveModelTier(model("gpt-5-nano", "openai", 0.15), noEnv)).toBe("tiny");
		// o3 family → cheap; prior-gen GPT-4x → tiny.
		expect(resolveModelTier(model("o3-pro", "openai", 20), noEnv)).toBe("cheap");
		expect(resolveModelTier(model("gpt-4o", "openai", 2.5), noEnv)).toBe("tiny");
	});

	it("uses the name-class cap for lean models over price", () => {
		expect(resolveModelTier(model("gemini-2.5-flash", "google", 0.3), noEnv)).toBe("tiny"); // flash cap + tiny price
		expect(resolveModelTier(model("gemini-3-flash-preview", "google", 1.12), noEnv)).toBe("cheap"); // flash cap over workhorse price
		expect(resolveModelTier(model("gemini-3.1-flash-lite", "google", 0.56), noEnv)).toBe("tiny"); // flash-lite anchor
		expect(resolveModelTier(model("qwen3-32b", "groq", 0.29), noEnv)).toBe("tiny"); // 32b size tag
	});

	it("classifies unpriced / opaque / unknown as tiny (maximum scaffolding)", () => {
		expect(resolveModelTier(model("glm-5", "zai", 0), noEnv)).toBe("tiny"); // 0 is not priced
		expect(resolveModelTier(model("some-model", "ollama"), noEnv)).toBe("tiny"); // opaque local provider
		expect(resolveModelTier(undefined, noEnv)).toBe("tiny");
	});

	it("does not let an opaque/local model reach the anchor map via an aliased id", () => {
		// A local model aliased to a flagship name must NOT inherit its tier — opaque
		// providers are unverifiable, so max scaffolding wins over the anchor.
		expect(resolveModelTier(model("claude-sonnet-5", "ollama"), noEnv)).toBe("tiny");
		expect(resolveModelTier(model("gpt-5", "ollama"), noEnv)).toBe("tiny");
	});

	it("treats an 'instant'-class name as tiny, not cheap", () => {
		expect(resolveModelTier(model("acme-instant", "acme", 2), noEnv)).toBe("tiny"); // instant cap beats workhorse price
	});

	it("keeps a cheap or unpriced 'pro'/'max'-class flagship in workhorse", () => {
		expect(resolveModelTier(model("deepseek-v4-pro", "deepseek", 0.435), noEnv)).toBe("workhorse");
		expect(resolveModelTier(model("qwen3.8-max", "alibaba", 0.4), noEnv)).toBe("workhorse");
		expect(resolveModelTier(model("gemini-3-pro-preview", "google", 2), noEnv)).toBe("workhorse"); // anchor
		expect(resolveModelTier(model("some-model-pro", "acme"), noEnv)).toBe("workhorse"); // unpriced but pro
	});

	it("matches capable/lean hints only as delimited tokens, not substrings", () => {
		// "prometheus-8b": no substring "pro" rescue; the 8b size tag pins it tiny.
		expect(resolveModelTier(model("prometheus-8b", "deepseek", 0.1), noEnv)).toBe("tiny");
	});

	it("classifies a gateway-proxied Anthropic model via the anchor map", () => {
		// Proxied (non-first-party) Sonnet can't be frontier-verified → workhorse.
		expect(resolveModelTier(model("anthropic/claude-sonnet-5", "openrouter", 3), noEnv)).toBe("workhorse");
		expect(resolveModelTier(model("anthropic/claude-haiku-4-5", "openrouter", 1), noEnv)).toBe("cheap");
	});

	it("honors the CC_PROMPT_TIER override over classification", () => {
		const env = (v: string) => ({ CC_PROMPT_TIER: v }) as unknown as NodeJS.ProcessEnv;
		expect(resolveModelTier(model("claude-opus-5", "anthropic"), env("cheap"))).toBe("cheap");
		expect(resolveModelTier(undefined, env("frontier"))).toBe("frontier");
		expect(resolveModelTier(model("gpt-5-mini", "openai", 0.25), env("workhorse"))).toBe("workhorse");
		// unrecognized value falls through to classification
		expect(resolveModelTier(model("claude-opus-5", "anthropic"), env("mid"))).toBe("frontier");
	});
});

describe("economicalContainedCandidates", () => {
	const ids = (models: Model<Api>[]) => models.map((m) => m.id);

	it("ranks cheapest capable tier first (cheap → workhorse → frontier)", () => {
		const session = model("claude-opus-4-8", "anthropic", 15); // frontier
		const available = [
			session,
			model("claude-sonnet-5", "anthropic", 3), // workhorse
			model("claude-haiku-4-5", "anthropic", 1), // cheap
		];
		// cheap (haiku) before workhorse (sonnet) before frontier (opus, the session).
		expect(ids(economicalContainedCandidates(available, session))).toEqual([
			"claude-haiku-4-5",
			"claude-sonnet-5",
			"claude-opus-4-8",
		]);
	});

	it("orders within a tier by price ascending", () => {
		const session = model("gpt-5.5", "openai", 10); // workhorse
		const available = [session, model("gpt-5-mini", "openai", 0.25), model("gpt-5.4-mini", "openai", 0.75)];
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-5-mini", "gpt-5.4-mini", "gpt-5.5"]);
	});

	it("excludes tiny-tier and unpriced models", () => {
		const session = model("gpt-5.5", "openai", 10);
		const available = [
			session,
			model("gpt-5-mini", "openai", 0.25), // cheap
			model("gpt-5-nano", "openai", 0.05), // tiny
			model("gpt-5-mystery", "openai"), // unpriced
		];
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-5-mini", "gpt-5.5"]);
	});

	it("stays within the session's provider containment", () => {
		const session = model("gpt-5.5", "openai", 10);
		const available = [session, model("gpt-5-mini", "openai", 0.25), model("claude-haiku-4-5", "anthropic", 1)];
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-5-mini", "gpt-5.5"]);
	});

	it("ignores CC_PROMPT_TIER — selection uses intrinsic tiers, so the floor still excludes tiny", () => {
		// CC_PROMPT_TIER forces the session's *prompt register*; it must not collapse
		// candidate classification and let a tiny model past the security floor.
		const session = model("gpt-5.5", "openai", 10);
		const available = [session, model("gpt-5-mini", "openai", 0.25), model("gpt-5-nano", "openai", 0.05)];
		const prev = process.env.CC_PROMPT_TIER;
		process.env.CC_PROMPT_TIER = "workhorse";
		try {
			expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-5-mini", "gpt-5.5"]);
		} finally {
			if (prev === undefined) delete process.env.CC_PROMPT_TIER;
			else process.env.CC_PROMPT_TIER = prev;
		}
	});
});

describe("pickEconomicalContainedModel", () => {
	it("returns the cheapest capable model no dearer than the session, tagged 'tier'", () => {
		const session = model("claude-opus-4-8", "anthropic", 15);
		const available = [session, model("claude-haiku-4-5", "anthropic", 1)];
		expect(pickEconomicalContainedModel(available, session)).toMatchObject({
			via: "tier",
			model: { id: "claude-haiku-4-5" },
		});
	});

	it("falls back to the session model when nothing cheaper and capable exists", () => {
		const session = model("claude-haiku-4-5", "anthropic", 1);
		const available = [session, model("claude-sonnet-5", "anthropic", 3)];
		expect(pickEconomicalContainedModel(available, session)).toMatchObject({
			via: "session",
			model: { id: "claude-haiku-4-5" },
		});
	});

	it("returns undefined without a session model", () => {
		expect(pickEconomicalContainedModel([model("gpt-5-mini", "openai", 0.25)], undefined)).toBeUndefined();
	});
});

describe("tierOverride", () => {
	it("parses valid tiers case-insensitively and ignores the rest", () => {
		expect(tierOverride({ CC_PROMPT_TIER: "TINY" } as unknown as NodeJS.ProcessEnv)).toBe("tiny");
		expect(tierOverride({ CC_PROMPT_TIER: "workhorse" } as unknown as NodeJS.ProcessEnv)).toBe("workhorse");
		expect(tierOverride({ CC_PROMPT_TIER: "mid" } as unknown as NodeJS.ProcessEnv)).toBeUndefined(); // retired name
		expect(tierOverride({ CC_PROMPT_TIER: "auto" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
		expect(tierOverride({} as NodeJS.ProcessEnv)).toBeUndefined();
	});
});
