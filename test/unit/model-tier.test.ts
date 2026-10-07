import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	classifyModelTier,
	economicalContainedCandidates,
	isPromptTier,
	pickEconomicalContainedModel,
	resolveModelTier,
	sameTierContainedCandidates,
	setModelTierOverridesForTest,
	taskToolsEnabled,
	tierOverride,
	usesClaudeCodeFastPaths,
} from "../../extensions/lib/model-tier.ts";
import { type FixtureModel, pinCatalog } from "./catalog-fixture.ts";

/** Minimal fake — the tier code reads only id/provider/cost. */
function model(id: string, provider: string, inputCost?: number): Model<Api> {
	return { id, provider, cost: inputCost === undefined ? undefined : { input: inputCost } } as unknown as Model<Api>;
}
const noEnv = {} as NodeJS.ProcessEnv;

/** A current Anthropic lineup (vendor prices per million tokens). */
const ANTHROPIC: FixtureModel[] = [
	{ id: "anthropic/claude-fable-5-1", released: "2026-09-01", price: [10, 50] },
	{ id: "anthropic/claude-opus-5-5", released: "2026-09-22", price: [4, 20] },
	{ id: "anthropic/claude-sonnet-5-5", released: "2026-09-28", price: [2, 10], servedAs: ["openrouter/anthropic/claude-sonnet-5.5"] },
	{ id: "anthropic/claude-opus-4-7", released: "2026-04-14", price: [5, 25] },
	{ id: "anthropic/claude-sonnet-5", released: "2026-06-29", price: [2, 10] },
	{ id: "anthropic/claude-haiku-4-5", released: "2025-10-15", price: [1, 5], servedAs: ["openrouter/anthropic/claude-haiku-4.5"] },
	{ id: "anthropic/claude-sonnet-4", released: "2025-05-22", price: [3, 15] },
];

/** A current OpenAI lineup, with premium SKUs that must not set the bar. */
const OPENAI: FixtureModel[] = [
	{ id: "openai/gpt-6-astra", released: "2026-09-04", price: [5, 40] },
	{ id: "openai/gpt-6-astra-fast", released: "2026-09-04", price: [10, 80] },
	{ id: "openai/gpt-6-sol-pro", released: "2026-09-22", price: [30, 180] },
	{ id: "openai/gpt-6-sol", released: "2026-09-22", price: [1, 13] },
	{ id: "openai/gpt-6-luna", released: "2026-09-22", price: [0.1, 0.5] },
	{ id: "openai/gpt-5.6-sol", released: "2026-07-09", price: [2.5, 30] },
	{ id: "openai/gpt-5.6-terra", released: "2026-07-09", price: [1.5, 12] },
	{ id: "openai/gpt-5.5", released: "2026-04-23", price: [5, 30] },
	{ id: "openai/gpt-5.4-mini", released: "2026-03-17", price: [0.75, 4.5] },
	{ id: "openai/gpt-5.4-nano", released: "2026-03-17", price: [0.2, 1.25] },
];

/** An open-weight vendor: every current model has a published size. */
const DEEPSEEK: FixtureModel[] = [
	{ id: "deepseek/deepseek-v4-pro", released: "2026-08-12", price: [0.435, 0.87], params: 1.6e12 },
	{ id: "deepseek/deepseek-v4.1-flash", released: "2026-09-10", price: [0.15, 0.6], params: 284e9 },
	{ id: "deepseek/deepseek-v4-flash", released: "2026-04-24", price: [0.14, 0.28], params: 284e9 },
	{ id: "deepseek/deepseek-r1-distill-32b", released: "2026-05-01", price: [0.1, 0.2], params: 32e9 },
];

describe("isPromptTier", () => {
	it("accepts the four tier names and nothing inherited from Object.prototype", () => {
		for (const tier of ["frontier", "workhorse", "cheap", "tiny"]) expect(isPromptTier(tier)).toBe(true);
		for (const value of ["toString", "constructor", "hasOwnProperty", "__proto__", "", 3, undefined]) expect(isPromptTier(value)).toBe(false);
	});
});

describe("resolveModelTier", () => {
	it("classifies first-party Anthropic Opus ≥4.8, Sonnet ≥5.5 and Fable as frontier, with or without a catalog", () => {
		for (const id of ["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-6", "claude-fable-5", "claude-fable-5-1"]) {
			expect(resolveModelTier(model(id, "anthropic"), noEnv)).toBe("frontier");
		}
	});

	it("keeps Opus 4.7 and Sonnet 5 below frontier, as Claude Code gives them the long prompt", () => {
		pinCatalog(ANTHROPIC);
		expect(resolveModelTier(model("claude-opus-4-7", "anthropic", 5), noEnv)).toBe("workhorse");
		expect(resolveModelTier(model("claude-sonnet-5", "anthropic", 2), noEnv)).toBe("workhorse");
		// A gateway copy cannot be verified for the frontier gate: its catalog tier serves.
		expect(resolveModelTier(model("anthropic/claude-sonnet-5.5", "openrouter", 2), noEnv)).toBe("workhorse");
	});

	it("classifies first-party OpenAI Astra/Sol ≥6 as frontier", () => {
		for (const provider of ["openai", "openai-codex", "azure-openai-responses"]) {
			for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol-pro", "gpt-7-astra"]) {
				expect(resolveModelTier(model(id, provider, 2), noEnv)).toBe("frontier");
			}
		}
		expect(resolveModelTier(model("openai/gpt-6-sol", "openrouter", 2), noEnv)).not.toBe("frontier");
		expect(resolveModelTier(model("gpt-6-sol", "github-copilot", 2), noEnv)).not.toBe("frontier");
	});

	it("does not read a dated suffix as the minor version", () => {
		expect(resolveModelTier(model("claude-opus-4-8-20251101", "anthropic"), noEnv)).toBe("frontier");
	});

	it("places a closed vendor's models by price against the median of its current models, so premium SKUs do not set the bar", () => {
		pinCatalog([...ANTHROPIC, ...OPENAI]);
		// Haiku at a fifth of Anthropic's median is cheap; the 2025 Sonnet 4 is over a
		// year older than the newest workhorse-class model, so it drops a step.
		expect(classifyModelTier(model("claude-haiku-4-5", "anthropic", 1), noEnv)).toMatchObject({ tier: "cheap" });
		expect(classifyModelTier(model("claude-sonnet-4", "anthropic", 3), noEnv)).toMatchObject({ tier: "cheap", reason: expect.stringContaining("over a year older") });
		// OpenAI: the -pro and -fast SKUs do not drag Terra into cheap; Luna and mini stay cheap.
		expect(resolveModelTier(model("gpt-5.6-terra", "openai", 1.5), noEnv)).toBe("workhorse");
		expect(resolveModelTier(model("gpt-6-luna", "openai", 0.1), noEnv)).toBe("cheap");
		expect(resolveModelTier(model("gpt-5.4-mini", "openai", 0.75), noEnv)).toBe("cheap");
		// A nano model publishes no size: its name marks it small.
		expect(resolveModelTier(model("gpt-5.4-nano", "openai", 0.2), noEnv)).toBe("tiny");
	});

	it("places an open-weight vendor's models by size: tiny under 40B, workhorse from half the largest", () => {
		pinCatalog(DEEPSEEK);
		expect(resolveModelTier(model("deepseek-v4-pro", "deepseek", 0.435), noEnv)).toBe("workhorse");
		expect(resolveModelTier(model("deepseek-v4.1-flash", "deepseek", 0.15), noEnv)).toBe("cheap");
		expect(resolveModelTier(model("deepseek-r1-distill-32b", "deepseek", 0.1), noEnv)).toBe("tiny");
	});

	it("needs three current priced models to compare against; with fewer, the vendor's models are cheap", () => {
		pinCatalog([
			{ id: "acme/acme-large", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/acme-small", released: "2026-08-01", price: [0.3, 1.5] },
		]);
		expect(classifyModelTier(model("acme/acme-large", "openrouter", 3), noEnv)).toMatchObject({ tier: "cheap", reason: expect.stringContaining("too few") });
	});

	it("matches a gateway or hosted row to the vendor's own model", () => {
		pinCatalog([...ANTHROPIC, { id: "zhipuai/glm-5.3", released: "2026-08-14", price: [1, 3.2] }, { id: "zhipuai/glm-5.2", released: "2026-06-13", price: [1, 3.2] }, { id: "zhipuai/glm-5.3-flash", released: "2026-08-26", price: [0.1, 0.6] }]);
		expect(classifyModelTier(model("anthropic/claude-haiku-4.5", "openrouter", 1), noEnv)).toMatchObject({ tier: "cheap", reason: expect.stringContaining("anthropic/claude-haiku-4-5") });
		// Together and the Qwen plan name it as the vendor does; the bare id is unique.
		expect(classifyModelTier(model("zai-org/GLM-5.3", "together", 1), noEnv)).toMatchObject({ tier: "workhorse", reason: expect.stringContaining("zhipuai/glm-5.3") });
		expect(classifyModelTier(model("glm-5.3-flash", "qwen-token-plan"), noEnv)).toMatchObject({ tier: "cheap", reason: expect.stringContaining("zhipuai/glm-5.3-flash") });
	});

	it("never matches a custom provider's id to a catalog model", () => {
		pinCatalog(ANTHROPIC);
		// A local model aliased to a flagship name must NOT inherit its tier.
		expect(classifyModelTier(model("claude-sonnet-5", "ollama", 3), noEnv)).toMatchObject({ tier: "tiny", reason: "custom provider, not in the catalogs" });
	});

	it("falls back without a catalog entry: small size or name, custom provider and unpriced are tiny, the rest cheap", () => {
		expect(resolveModelTier(model("qwen3-32b", "groq", 0.29), noEnv)).toBe("tiny"); // 32B size tag
		expect(resolveModelTier(model("gemma-4-e2b", "groq", 0.05), noEnv)).toBe("tiny"); // effective-size tag
		expect(resolveModelTier(model("acme-lite", "groq", 0.2), noEnv)).toBe("tiny"); // small-model name
		expect(resolveModelTier(model("prometheus-8b", "deepseek", 0.1), noEnv)).toBe("tiny"); // delimited, not "pro"
		expect(resolveModelTier(model("glm-5", "zai", 0), noEnv)).toBe("tiny"); // 0 is not priced
		expect(resolveModelTier(model("some-model", "ollama", 2), noEnv)).toBe("tiny"); // custom provider
		expect(resolveModelTier(undefined, noEnv)).toBe("tiny");
		expect(classifyModelTier(model("llama-4-405b", "groq", 1), noEnv)).toEqual({ tier: "cheap", reason: "not in the catalogs" });
	});

	it("honors the user's modelTiers setting, by provider/id or bare id, ahead of the gate and the catalog", () => {
		pinCatalog(ANTHROPIC);
		setModelTierOverridesForTest({ "anthropic/claude-haiku-4-5": "workhorse", "glm-5": "cheap", "claude-opus-5-5": "cheap" });
		expect(classifyModelTier(model("claude-haiku-4-5", "anthropic", 1), noEnv)).toEqual({ tier: "workhorse", reason: "modelTiers setting" });
		expect(resolveModelTier(model("glm-5", "zai", 0), noEnv)).toBe("cheap");
		expect(resolveModelTier(model("claude-opus-5-5", "anthropic", 4), noEnv)).toBe("cheap");
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
	beforeEach(() => pinCatalog([...ANTHROPIC, ...OPENAI]));

	it("ranks cheapest tier first (cheap → workhorse → frontier)", () => {
		const session = model("claude-opus-5-5", "anthropic", 4); // frontier
		const available = [session, model("claude-sonnet-5", "anthropic", 2), model("claude-haiku-4-5", "anthropic", 1)];
		// Sonnet 5 is superseded by Sonnet 5.5, which this account does not list: still skipped.
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
	});

	// Astra is frontier on OpenAI's own API; Terra is superseded by GPT-6 Sol,
	// so it is never an automatic pick even as the session row.
	it("orders within a tier by price ascending", () => {
		const session = model("gpt-6-astra", "openai", 5);
		const available = [session, model("gpt-5.4-mini", "openai", 0.75), model("gpt-6-luna", "openai", 0.1)];
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-6-luna", "gpt-5.4-mini", "gpt-6-astra"]);
	});

	it("excludes tiny, unpriced, superseded and uncatalogued models", () => {
		const session = model("gpt-6-astra", "openai", 5);
		const available = [
			session,
			model("gpt-6-luna", "openai", 0.1), // cheap
			model("gpt-5.4-nano", "openai", 0.2), // tiny
			model("gpt-6-sol", "openai"), // unpriced on this route
			model("gpt-5.6-terra", "openai", 1.5), // superseded by GPT-6 Sol
			model("gpt-5-mystery", "openai", 0.3), // no catalog knows it
		];
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-6-luna", "gpt-6-astra"]);
	});

	it("stays within the session's provider containment", () => {
		const session = model("gpt-6-astra", "openai", 5);
		const available = [session, model("gpt-6-luna", "openai", 0.1), model("claude-haiku-4-5", "anthropic", 1)];
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-6-luna", "gpt-6-astra"]);
	});

	it("ignores CC_PROMPT_TIER — selection uses intrinsic tiers, so the floor still excludes tiny", () => {
		const session = model("gpt-6-astra", "openai", 5);
		const available = [session, model("gpt-6-luna", "openai", 0.1), model("gpt-5.4-nano", "openai", 0.2)];
		const prev = process.env.CC_PROMPT_TIER;
		process.env.CC_PROMPT_TIER = "workhorse";
		try {
			expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-6-luna", "gpt-6-astra"]);
		} finally {
			if (prev === undefined) delete process.env.CC_PROMPT_TIER;
			else process.env.CC_PROMPT_TIER = prev;
		}
	});

	it("with requireImageInput, drops text-only candidates", () => {
		const withInput = (id: string, cost: number, input: string[]) => ({ id, provider: "openai", cost: { input: cost }, input }) as unknown as Model<Api>;
		const session = withInput("gpt-6-astra", 5, ["text", "image"]);
		const available = [session, withInput("gpt-6-luna", 0.1, ["text"]), withInput("gpt-5.4-mini", 0.75, ["text", "image"])];
		expect(ids(economicalContainedCandidates(available, session))).toEqual(["gpt-6-luna", "gpt-5.4-mini", "gpt-6-astra"]);
		expect(ids(economicalContainedCandidates(available, session, undefined, true))).toEqual(["gpt-5.4-mini", "gpt-6-astra"]);
	});
});

describe("sameTierContainedCandidates", () => {
	it("keeps the session's tier or above, strictly cheaper, cheapest first", () => {
		pinCatalog([...ANTHROPIC, ...OPENAI]);
		const ids = (models: Model<Api>[]) => models.map((m) => m.id);
		const fable = model("claude-fable-5-1", "anthropic", 10);
		const anthropic = [fable, model("claude-opus-5-5", "anthropic", 4), model("claude-sonnet-5-5", "anthropic", 2), model("claude-haiku-4-5", "anthropic", 1)];
		expect(ids(sameTierContainedCandidates(anthropic, fable))).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
		// A cheaper model in a lower tier is never a same-tier pick.
		const astra = model("gpt-6-astra", "openai", 5);
		expect(ids(sameTierContainedCandidates([astra, model("gpt-6-luna", "openai", 0.1)], astra))).toEqual([]);
	});
});

describe("pickEconomicalContainedModel", () => {
	beforeEach(() => pinCatalog(ANTHROPIC));

	it("returns the cheapest non-tiny model no dearer than the session, tagged 'tier'", () => {
		const session = model("claude-opus-5-5", "anthropic", 4);
		const available = [session, model("claude-haiku-4-5", "anthropic", 1)];
		expect(pickEconomicalContainedModel(available, session)).toMatchObject({ via: "tier", model: { id: "claude-haiku-4-5" } });
	});

	it("falls back to the session model when nothing cheaper exists", () => {
		const session = model("claude-haiku-4-5", "anthropic", 1);
		const available = [session, model("claude-sonnet-5-5", "anthropic", 2)];
		expect(pickEconomicalContainedModel(available, session)).toMatchObject({ via: "session", model: { id: "claude-haiku-4-5" } });
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

describe("usesClaudeCodeFastPaths (decisions/auto-mode.md, \"Two gates by model tier\")", () => {
	it("gives frontier and workhorse Claude Code's fast paths, and cheap, tiny or no model the stricter gate", () => {
		pinCatalog(ANTHROPIC);
		expect(usesClaudeCodeFastPaths(model("claude-opus-5", "anthropic"))).toBe(true);
		expect(usesClaudeCodeFastPaths(model("claude-sonnet-5", "anthropic"))).toBe(true);
		expect(usesClaudeCodeFastPaths(model("claude-haiku-4-5", "anthropic"))).toBe(false);
		expect(usesClaudeCodeFastPaths(undefined)).toBe(false);
	});

	it("ignores CC_PROMPT_TIER, so a forced register never loosens the gate", () => {
		pinCatalog(ANTHROPIC);
		const prev = process.env.CC_PROMPT_TIER;
		process.env.CC_PROMPT_TIER = "frontier";
		try {
			expect(usesClaudeCodeFastPaths(model("claude-haiku-4-5", "anthropic"))).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.CC_PROMPT_TIER;
			else process.env.CC_PROMPT_TIER = prev;
		}
	});
});

describe("taskToolsEnabled (Claude Code's model gate for the task tools)", () => {
	it("withholds them from frontier models and Sonnet 5 or later", () => {
		for (const [id, provider] of [
			["claude-fable-5-1", "anthropic"],
			["claude-opus-5-5", "anthropic"],
			["claude-sonnet-5", "anthropic"],
			["claude-sonnet-5-2", "anthropic"],
			["gpt-6-astra", "openai"],
			["gpt-6-sol", "openai-codex"],
		]) {
			expect(taskToolsEnabled(model(id, provider, 2), noEnv), id).toBe(false);
		}
	});

	it("keeps them for older and third-party models, and an unknown model", () => {
		for (const [id, provider] of [
			["claude-sonnet-4-6", "anthropic"],
			["claude-haiku-4-5", "anthropic"],
			["gpt-5.6-sol", "openai"],
			["gpt-6-luna", "openai"],
			["deepseek/deepseek-v4.1-flash", "openrouter"],
			["anthropic/claude-opus-5.5", "openrouter"],
		]) {
			expect(taskToolsEnabled(model(id, provider, 2), noEnv), id).toBe(true);
		}
		expect(taskToolsEnabled(undefined, noEnv)).toBe(true);
	});

	it("turns them back on with CLAUDE_CODE_ENABLE_TODO_TOOLS", () => {
		const opus = model("claude-opus-5-5", "anthropic");
		for (const value of ["1", "true", "YES", "on"]) {
			expect(taskToolsEnabled(opus, { CLAUDE_CODE_ENABLE_TODO_TOOLS: value } as NodeJS.ProcessEnv)).toBe(true);
		}
		expect(taskToolsEnabled(opus, { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});

	it("follows a forced tier", () => {
		expect(taskToolsEnabled(model("deepseek/deepseek-v4.1-flash", "openrouter", 0.15), { CC_PROMPT_TIER: "frontier" } as NodeJS.ProcessEnv)).toBe(false);
	});
});
