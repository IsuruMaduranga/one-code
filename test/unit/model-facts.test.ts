import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	generationLagDays,
	isPriorGeneration,
	lacksToolCalls,
	modelFacts,
	modelFamily,
	modelGeneration,
	setModelFactsForTest,
} from "../../extensions/lib/model-facts.ts";
import { classifyModelTier, economicalContainedCandidates, pickEconomicalContainedModel, resolveModelTier } from "../../extensions/lib/model-tier.ts";
import { resolveSubagentModel } from "../../extensions/subagents/model-select.ts";

const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, api: "openai-completions", cost: input === undefined ? undefined : { input, output: input * 3 } }) as unknown as Model<Api>;
const noEnv = {} as NodeJS.ProcessEnv;

/** A synthetic table shaped like the bundled one (dates chosen for the thresholds). */
const FACTS = {
	"openrouter/deepseek/deepseek-v4-pro": { releaseDate: "2026-08-13" },
	"openrouter/deepseek/deepseek-v4-flash": { releaseDate: "2026-04-24" },
	"openrouter/deepseek/deepseek-r1-0528": { releaseDate: "2025-05-28" }, // 442 days behind → prior
	"openrouter/deepseek/deepseek-chat": { releaseDate: "2024-03-01" }, // > 730 days → ancient
	"deepseek/deepseek-v4-flash": { releaseDate: "2026-04-24" }, // same family across providers
	"openai/gpt-5.6-sol": { releaseDate: "2026-07-09" },
	"openai/gpt-5-mini": { releaseDate: "2025-08-07" }, // 336 days → current
	"openai/gpt-4o": { releaseDate: "2024-05-13" }, // ancient
	"openai/o3": { releaseDate: "2025-04-16" }, // 449 days → prior (anchored cheap stays cheap; excluded from selection)
	"openai/text-only-legacy": { releaseDate: "2026-07-01", toolCall: false as const },
};

describe("model facts", () => {
	beforeEach(() => setModelFactsForTest(FACTS));

	it("groups rows into vendor families across providers and measures lag against the family's newest", () => {
		expect(modelFamily(model("openrouter", "deepseek/deepseek-v4-flash"))).toBe("deepseek");
		expect(modelFamily(model("deepseek", "deepseek-v4-flash"))).toBe("deepseek");
		expect(generationLagDays(model("openrouter", "deepseek/deepseek-v4-pro"))).toBe(0);
		expect(generationLagDays(model("deepseek", "deepseek-v4-flash"))).toBe(111);
		expect(generationLagDays(model("openrouter", "deepseek/deepseek-r1-0528"))).toBe(442);
	});

	it("classifies generation with the one- and two-year thresholds", () => {
		expect(modelGeneration(model("openrouter", "deepseek/deepseek-v4-flash"))).toBe("current");
		expect(modelGeneration(model("openrouter", "deepseek/deepseek-r1-0528"))).toBe("prior");
		expect(modelGeneration(model("openrouter", "deepseek/deepseek-chat"))).toBe("ancient");
		expect(modelGeneration(model("openai", "gpt-5-mini"))).toBe("current");
		expect(modelGeneration(model("openrouter", "deepseek/deepseek-v4.1-flash"))).toBeUndefined(); // no row → no facts
		expect(isPriorGeneration(model("openrouter", "deepseek/deepseek-r1-0528"))).toBe(true);
		expect(isPriorGeneration(model("openrouter", "deepseek/deepseek-v4.1-flash"))).toBe(false);
	});

	it("resolves ~redirect aliases and :variants through their base id", () => {
		expect(modelFacts(model("openrouter", "~deepseek/deepseek-v4-flash"))?.releaseDate).toBe("2026-04-24");
		expect(modelFacts(model("openrouter", "deepseek/deepseek-v4-flash:batch"))?.releaseDate).toBe("2026-04-24");
		expect(lacksToolCalls(model("openai", "text-only-legacy"))).toBe(true);
		expect(lacksToolCalls(model("openai", "gpt-5.6-sol"))).toBe(false);
	});
});

describe("classifyModelTier with facts", () => {
	beforeEach(() => setModelFactsForTest(FACTS));

	it("uses the name class for current-generation rows, price ignored", () => {
		// Priced far below the old $0.50 floor, yet cheap by name and current by date.
		expect(classifyModelTier(model("openrouter", "deepseek/deepseek-v4-flash", 0.085), noEnv)).toEqual({ tier: "cheap", reason: "anchor" });
		expect(classifyModelTier(model("openai", "gpt-5.6-sol", 4.5), noEnv)).toEqual({ tier: "workhorse", reason: "name class" }); // the blanket gpt-5 anchor is gone
		expect(classifyModelTier(model("openai", "gpt-5-mini", 0.25), noEnv)).toEqual({ tier: "cheap", reason: "anchor" });
	});

	it("demotes the name-class path one tier at one generation behind, everything to tiny at two", () => {
		// A curated anchor already weighed the model's generation, so it keeps its tier
		// one generation behind (o3 stays cheap) — but two generations behind is tiny for all.
		expect(classifyModelTier(model("openai", "o3", 2), noEnv)).toEqual({ tier: "cheap", reason: "anchor" });
		expect(classifyModelTier(model("openai", "gpt-4o", 2.5), noEnv)).toEqual({ tier: "tiny", reason: "anchor · two generations behind" });
		// An unanchored, unmarked prior-generation flagship name would be workhorse; a year behind it is cheap.
		setModelFactsForTest({ ...FACTS, "openrouter/moonshotai/kimi-k2": { releaseDate: "2025-07-11" }, "openrouter/moonshotai/kimi-k3": { releaseDate: "2026-07-16" } });
		expect(classifyModelTier(model("openrouter", "moonshotai/kimi-k2", 0.6), noEnv)).toEqual({ tier: "cheap", reason: "name class · one generation behind" });
		expect(classifyModelTier(model("openrouter", "moonshotai/kimi-k3", 0.6), noEnv)).toEqual({ tier: "workhorse", reason: "name class" });
	});

	it("never consults facts for an opaque provider, and no longer lets a 'pro' name lift one", () => {
		setModelFactsForTest({ ...FACTS, "ollama/deepseek-v4-pro": { releaseDate: "2026-08-13" } });
		expect(classifyModelTier(model("ollama", "deepseek-v4-pro", 0.4), noEnv)).toEqual({ tier: "tiny", reason: "opaque provider" });
	});

	it("borrows a release date from the same model on another provider, never the tool-call flag", () => {
		// models.dev has no openai-codex entries; the Codex row is the same model as openai's.
		expect(modelFacts(model("openai-codex", "gpt-5.6-sol"))).toEqual({ releaseDate: "2026-07-09" });
		expect(classifyModelTier(model("openai-codex", "gpt-5.6-sol", 5), noEnv)).toEqual({ tier: "workhorse", reason: "name class" });
		expect(modelFacts(model("openai-codex", "text-only-legacy"))).toEqual({ releaseDate: "2026-07-01" }); // toolCall: false stays with openai's own row
		expect(lacksToolCalls(model("openai-codex", "text-only-legacy"))).toBe(false);
		// Providers that disagree on the date (OpenRouter's April flash vs DeepSeek's July one) lend nothing.
		setModelFactsForTest({ ...FACTS, "deepseek/deepseek-v4-flash": { releaseDate: "2026-07-31" } });
		expect(modelFacts(model("baseten", "deepseek-ai/DeepSeek-V4-Flash"))).toBeUndefined();
		// An opaque identity never borrows: a local "gpt-5.6-sol" is not OpenAI's.
		expect(modelFacts(model("ollama", "gpt-5.6-sol"))).toBeUndefined();
	});

	it("falls back to the pre-facts heuristics for a row without facts", () => {
		expect(classifyModelTier(model("openrouter", "deepseek/deepseek-v4.1-flash", 0.15), noEnv)).toEqual({ tier: "cheap", reason: "anchor" });
		expect(classifyModelTier(model("openrouter", "mistralai/unknown-model", 0.2), noEnv)).toEqual({ tier: "tiny", reason: "price floor, no facts" });
		expect(classifyModelTier(model("openrouter", "mistralai/unknown-pro", 0.2), noEnv)).toEqual({ tier: "workhorse", reason: "capable name, no facts" });
		expect(classifyModelTier(model("openrouter", "mistralai/unknown-model"), noEnv)).toEqual({ tier: "tiny", reason: "unpriced, no facts" });
		// An unknown gateway route is an opaque identity: nothing lifts it.
		expect(classifyModelTier(model("openrouter", "someone/unknown-pro", 0.2), noEnv)).toEqual({ tier: "tiny", reason: "opaque provider" });
		expect(resolveModelTier(model("openrouter", "someone/unknown-model"), noEnv)).toBe("tiny");
	});
});

describe("automatic selection with facts", () => {
	beforeEach(() => setModelFactsForTest(FACTS));

	it("excludes prior-generation and non-tool-calling rows whatever their price", () => {
		const catalog = [
			model("openai", "gpt-5.6-sol", 4.5),
			model("openai", "gpt-5-mini", 0.25),
			model("openai", "o3", 2),
			model("openai", "gpt-4o", 2.5),
			model("openai", "text-only-legacy", 0.1),
		];
		expect(economicalContainedCandidates(catalog, catalog[0]).map((m) => m.id)).toEqual(["gpt-5-mini", "gpt-5.6-sol"]);
		// The reader takes the cheapest capable row; a subagent is held to the
		// session's workhorse floor, which mini does not meet, so Sol delegates to itself.
		expect(pickEconomicalContainedModel(catalog, catalog[0])?.model.id).toBe("gpt-5-mini");
		expect(resolveSubagentModel({ sessionModel: catalog[0], available: catalog })).toMatchObject({ model: { id: "gpt-5.6-sol" }, source: "session" });
	});

	it("lets the R1-over-Flash incident resolve to Flash even without the DeepSeek anchors", () => {
		const catalog = [
			model("openrouter", "deepseek/deepseek-v4-pro", 0.89),
			model("openrouter", "deepseek/deepseek-v4-flash", 0.085),
			model("openrouter", "deepseek/deepseek-r1-0528", 0.5),
			model("openrouter", "deepseek/deepseek-chat", 0.32),
		];
		// The generation facts drop R1 and deepseek-chat: the reader lands on Flash, and
		// a subagent (workhorse floor, no measured snapshot) on Pro itself — never on R1.
		expect(pickEconomicalContainedModel(catalog, catalog[0])?.model.id).toBe("deepseek/deepseek-v4-flash");
		const subagent = resolveSubagentModel({ sessionModel: catalog[0], available: catalog });
		expect(subagent.model?.id).toBe("deepseek/deepseek-v4-pro");
		expect(economicalContainedCandidates(catalog, catalog[0]).map((m) => m.id)).not.toContain("deepseek/deepseek-r1-0528");
	});
});
