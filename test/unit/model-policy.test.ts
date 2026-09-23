import { describe, expect, it } from "vitest";
import {
	BUILTIN_PROVIDER_POLICIES,
	crossesProvider,
	forcedReasoningLevel,
	isDatedDuplicate,
	isReasoningMandatoryError,
	isSelectableVariant,
	isSnapshotDatedId,
	modelIdentity,
	modelsContainedToSession,
	reasoningRetryLevel,
	stripSnapshotDate,
	withReasoningFallback,
} from "../../extensions/lib/model-policy.ts";

describe("isSelectableVariant", () => {
	it("excludes batch/free/online/thinking endpoint variants and OpenRouter's moving ~…-latest redirect aliases", () => {
		expect(isSelectableVariant(model("openrouter", "deepseek/deepseek-v4-flash"))).toBe(true);
		expect(isSelectableVariant(model("openrouter", "deepseek/deepseek-v4-flash-0731:batch"))).toBe(false);
		expect(isSelectableVariant(model("openrouter", "z-ai/glm-4.6:free"))).toBe(false);
		expect(isSelectableVariant(model("openrouter", "~deepseek/deepseek-v4-flash-latest"))).toBe(false);
		expect(isSelectableVariant(model("openrouter", "~anthropic/claude-sonnet-latest"))).toBe(false);
	});
});

describe("stripSnapshotDate / isDatedDuplicate", () => {
	it("strips a trailing -YYYYMMDD or a real -MMDD, and nothing else", () => {
		expect(stripSnapshotDate("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		expect(stripSnapshotDate("deepseek/deepseek-v4-flash-0731")).toBe("deepseek/deepseek-v4-flash");
		expect(stripSnapshotDate("deepseek/deepseek-v4-pro-0813")).toBe("deepseek/deepseek-v4-pro");
		expect(stripSnapshotDate("mistral-large-2411")).toBe("mistral-large-2411"); // month 24: a version, not a date
		expect(stripSnapshotDate("deepseek/deepseek-v4-flash-vision-exp")).toBe("deepseek/deepseek-v4-flash-vision-exp");
		expect(stripSnapshotDate("llama-3.1-405b")).toBe("llama-3.1-405b");
	});

	it("recognises both snapshot shapes as dated", () => {
		expect(isSnapshotDatedId("claude-haiku-4-5-20251001")).toBe(true);
		expect(isSnapshotDatedId("deepseek/deepseek-v4-flash-0731")).toBe(true);
		expect(isSnapshotDatedId("deepseek/deepseek-v4-flash")).toBe(false);
		expect(isSnapshotDatedId("mistral-large-2411")).toBe(false);
	});

	it("collapses a snapshot only onto its exact undated alias", () => {
		const pool = [
			{ id: "deepseek/deepseek-v4-flash" },
			{ id: "deepseek/deepseek-v4-flash-0731" },
			{ id: "deepseek/deepseek-v4-flash-vision-exp" },
			{ id: "deepseek/deepseek-v4-pro-0813" },
			{ id: "claude-haiku-4-5" },
			{ id: "claude-haiku-4-5-20251001" },
		];
		expect(isDatedDuplicate({ id: "deepseek/deepseek-v4-flash-0731" }, pool)).toBe(true);
		expect(isDatedDuplicate({ id: "claude-haiku-4-5-20251001" }, pool)).toBe(true);
		expect(isDatedDuplicate({ id: "deepseek/deepseek-v4-pro-0813" }, pool)).toBe(false); // no undated alias listed
		expect(isDatedDuplicate({ id: "deepseek/deepseek-v4-flash-vision-exp" }, pool)).toBe(false); // not a snapshot
		expect(isDatedDuplicate({ id: "deepseek/deepseek-v4-flash" }, pool)).toBe(false);
	});
});

const model = (provider: string, id: string, input = 1, api = "openai-responses") =>
	({
		provider,
		id,
		name: id,
		api,
		baseUrl: `https://${provider}.example.test`,
		reasoning: true,
		input: ["text"],
		cost: { input, output: input * 4, cacheRead: input / 10, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_000,
	}) as any;

const BUILTIN_PROVIDERS = [
	"amazon-bedrock",
	"ant-ling",
	"anthropic",
	"google",
	"google-vertex",
	"openai",
	"azure-openai-responses",
	"openai-codex",
	"radius",
	"nvidia",
	"deepseek",
	"github-copilot",
	"xai",
	"groq",
	"cerebras",
	"openrouter",
	"vercel-ai-gateway",
	"zai",
	"zai-coding-cn",
	"mistral",
	"minimax",
	"minimax-cn",
	"moonshotai",
	"moonshotai-cn",
	"huggingface",
	"fireworks",
	"together",
	"baseten",
	"opencode",
	"opencode-go",
	"kimi-coding",
	"cloudflare-workers-ai",
	"cloudflare-ai-gateway",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
] as const;

describe("built-in provider policies", () => {
	it("classifies every built-in pi language-model provider explicitly", () => {
		expect(Object.keys(BUILTIN_PROVIDER_POLICIES).sort()).toEqual([...BUILTIN_PROVIDERS].sort());
		expect(BUILTIN_PROVIDERS).toHaveLength(39);
	});

	it("marks opaque routers as session-only", () => {
		for (const provider of ["radius", "huggingface", "opencode", "opencode-go"]) {
			expect(BUILTIN_PROVIDER_POLICIES[provider]).toMatchObject({ kind: "opaque" });
		}
	});
});

describe("model identity and containment", () => {
	it("contains OpenRouter to the live model author and reuses a canonical profile", () => {
		const session = model("openrouter", "openai/gpt-5.6-sol", 5);
		const luna = model("openrouter", "openai/gpt-5.6-luna", 0.2);
		const haiku = model("openrouter", "anthropic/claude-haiku-4.5", 1);
		expect(modelIdentity(session)).toMatchObject({ profile: "openai", normalizedId: "gpt-5.6-sol" });
		// A different author (anthropic) is not contained to an openai-author session.
		expect(modelsContainedToSession([session, luna, haiku], session)).toEqual([session, luna]);
		expect(crossesProvider(haiku, session)).toBe(true);
		expect(crossesProvider(luna, session)).toBe(false);
	});

	it("reuses canonical profiles within a Vercel creator namespace", () => {
		const session = model("vercel-ai-gateway", "x-ai/grok-4.5", 3);
		const worker = model("vercel-ai-gateway", "x-ai/grok-4.3", 0.3);
		const other = model("vercel-ai-gateway", "zai/glm-5-turbo", 0.2);
		expect(modelIdentity(session).profile).toBe("xai");
		expect(modelsContainedToSession([session, worker, other], session)).toEqual([session, worker]);
		expect(crossesProvider(other, session)).toBe(true);
	});

	it("treats publisher prefixes as model names on a stable hosted provider", () => {
		const session = model("groq", "llama-3.3-70b-versatile", 0.6);
		const worker = model("groq", "openai/gpt-oss-20b", 0.075);
		expect(modelIdentity(session).containment).toBe("groq");
		expect(modelIdentity(worker).containment).toBe("groq");
		expect(modelsContainedToSession([session, worker], session)).toEqual([session, worker]);
	});

	it("keeps opaque routers on the exact session model", () => {
		const session = model("huggingface", "Qwen/Qwen3-Coder-Next", 0.2);
		const other = model("huggingface", "openai/gpt-oss-20b", 0.05);
		expect(modelsContainedToSession([session, other], session)).toEqual([session]);
	});

	it("separates Cloudflare gateway routes after pi strips source prefixes", () => {
		const openai = model("cloudflare-ai-gateway", "gpt-5.6-sol", 5, "openai-responses");
		const luna = model("cloudflare-ai-gateway", "gpt-5.6-luna", 0.2, "openai-responses");
		const claude = model("cloudflare-ai-gateway", "claude-haiku-4-5", 1, "anthropic-messages");
		expect(modelsContainedToSession([openai, luna, claude], openai)).toEqual([openai, luna]);
	});

	it("normalizes Bedrock region-qualified family IDs", () => {
		const session = model("amazon-bedrock", "us.anthropic.claude-sonnet-5", 2, "bedrock-converse-stream");
		const haiku = model(
			"amazon-bedrock",
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
			1,
			"bedrock-converse-stream",
		);
		const euHaiku = model(
			"amazon-bedrock",
			"eu.anthropic.claude-haiku-4-5-20251001-v1:0",
			1,
			"bedrock-converse-stream",
		);
		expect(modelIdentity(session)).toMatchObject({ profile: "anthropic", normalizedId: "claude-sonnet-5" });
		// Region normalization: the US-qualified Haiku shares the US session's
		// containment; the EU-qualified one is a different geography and does not.
		expect(modelIdentity(haiku).normalizedId).toBe("claude-haiku-4-5-20251001");
		expect(modelsContainedToSession([session, haiku, euHaiku], session)).toEqual([session, haiku]);
	});

	it("reads every Bedrock geography prefix the catalog uses, not only us/eu/apac/au/global", () => {
		for (const geo of ["jp", "in", "ca", "us-gov"]) {
			const session = model("amazon-bedrock", `${geo}.anthropic.claude-sonnet-5`, 2, "bedrock-converse-stream");
			const haiku = model("amazon-bedrock", `${geo}.anthropic.claude-haiku-4-5-20251001-v1:0`, 1, "bedrock-converse-stream");
			const usHaiku = model("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", 1, "bedrock-converse-stream");
			expect(modelIdentity(session)).toMatchObject({ profile: "anthropic", normalizedId: "claude-sonnet-5", confidence: "family" });
			expect(modelsContainedToSession([session, haiku, usHaiku], session)).toEqual([session, haiku]);
		}
	});

	it("fails unknown custom providers closed", () => {
		const session = model("custom", "flagship", 10);
		const cheap = model("custom", "cheap", 0.01);
		expect(modelsContainedToSession([session, cheap], session)).toEqual([session]);
	});
});

describe("forcedReasoningLevel / reasoningRetryLevel", () => {
	const withMap = (map: Record<string, string | null> | undefined, reasoning = true) =>
		({ ...model("google", "gemini-x"), reasoning, thinkingLevelMap: map }) as never;

	it("omits reasoning for non-reasoning models and models that support off", () => {
		expect(forcedReasoningLevel(withMap(undefined, false))).toBeUndefined();
		expect(forcedReasoningLevel(withMap(undefined))).toBeUndefined();
		expect(forcedReasoningLevel(withMap({ minimal: null }))).toBeUndefined();
	});

	it("returns the lowest supported level when off is marked unsupported", () => {
		// pi's catalog marks can't-disable-thinking models with thinkingLevelMap.off: null
		// (e.g. google/gemini-3.6-flash).
		expect(forcedReasoningLevel(withMap({ off: null }))).toBe("minimal");
		expect(forcedReasoningLevel(withMap({ off: null, minimal: null }))).toBe("low");
	});

	it("retry level is the lowest real level the model supports", () => {
		expect(reasoningRetryLevel(withMap(undefined))).toBe("minimal");
		expect(reasoningRetryLevel(withMap({ off: null, minimal: null }))).toBe("low");
		// Even a metadata-free non-reasoning model gets a real level: the provider
		// just told us thinking is mandatory, so the metadata is wrong.
		expect(reasoningRetryLevel(withMap(undefined, false))).toBe("minimal");
	});
});

describe("isReasoningMandatoryError", () => {
	it("matches the provider phrasings for thinking-cannot-be-disabled", () => {
		// The message Gemini 3.7 Flash actually returns (via 400).
		expect(isReasoningMandatoryError("400: Reasoning is mandatory for this endpoint and cannot be disabled.")).toBe(true);
		expect(isReasoningMandatoryError("thinking cannot be disabled for this model")).toBe(true);
		expect(isReasoningMandatoryError("reasoning must be enabled")).toBe(true);
		expect(isReasoningMandatoryError("Thinking is required for gemini-3.7-flash")).toBe(true);
	});

	it("does not match unrelated provider errors", () => {
		expect(isReasoningMandatoryError("model not found")).toBe(false);
		expect(isReasoningMandatoryError("invalid api key")).toBe(false);
		expect(isReasoningMandatoryError("rate limit exceeded")).toBe(false);
		expect(isReasoningMandatoryError("maximum context length exceeded. Reduce the prompt")).toBe(false);
	});
});

describe("withReasoningFallback", () => {
	const offOk = () => model("openai", "gpt-x"); // supports off (no thinkingLevelMap)
	const mustThink = () => ({ ...model("google", "gemini-x"), thinkingLevelMap: { off: null } }) as never;
	const ok = (extra: Record<string, unknown> = {}) => ({ stopReason: "stop", ...extra });
	const mandatory = () => ({ stopReason: "error", errorMessage: "400: Reasoning is mandatory and cannot be disabled." });

	it("sends no reasoning and never retries for a model that supports off", async () => {
		const seen: (string | undefined)[] = [];
		const res = await withReasoningFallback(offOk(), (r) => {
			seen.push(r);
			return Promise.resolve(ok({ value: 1 }));
		});
		expect(seen).toEqual([undefined]);
		expect(res).toMatchObject({ value: 1 });
	});

	it("sends the proactive level up front for a catalog-marked can't-disable model", async () => {
		const seen: (string | undefined)[] = [];
		await withReasoningFallback(mustThink(), (r) => {
			seen.push(r);
			return Promise.resolve(ok());
		});
		expect(seen).toEqual(["minimal"]); // no error, no retry — one call at the floor
	});

	it("retries once at the floor when a metadata-gap model 400s on the off request", async () => {
		const seen: (string | undefined)[] = [];
		const res = await withReasoningFallback(offOk(), (r) => {
			seen.push(r);
			return Promise.resolve(seen.length === 1 ? mandatory() : ok({ value: 2 }));
		});
		expect(seen).toEqual([undefined, "minimal"]); // off first, then retried at the floor
		expect(res).toMatchObject({ value: 2 });
	});

	it("does not retry a non-reasoning error", async () => {
		let calls = 0;
		const res = await withReasoningFallback(offOk(), () => {
			calls++;
			return Promise.resolve({ stopReason: "error", errorMessage: "model not found" });
		});
		expect(calls).toBe(1);
		expect(res.stopReason).toBe("error");
	});

	it("memoizes the learned level so a later call skips the failed round-trip", async () => {
		const learned = new Map<string, "minimal" | "low" | "medium" | "high" | "xhigh" | "max">();
		// First call learns via the 400.
		const seen1: (string | undefined)[] = [];
		await withReasoningFallback(
			offOk(),
			(r) => {
				seen1.push(r);
				return Promise.resolve(seen1.length === 1 ? mandatory() : ok());
			},
			learned,
		);
		expect(seen1).toEqual([undefined, "minimal"]);
		// Second call sends the learned level up front — one call, no failed attempt.
		const seen2: (string | undefined)[] = [];
		await withReasoningFallback(
			offOk(),
			(r) => {
				seen2.push(r);
				return Promise.resolve(ok());
			},
			learned,
		);
		expect(seen2).toEqual(["minimal"]);
	});
});
