import { describe, expect, it } from "vitest";
import {
	BUILTIN_PROVIDER_POLICIES,
	crossesProvider,
	forcedReasoningLevel,
	isReasoningMandatoryError,
	modelIdentity,
	modelsContainedToSession,
	reasoningRetryLevel,
} from "../../extensions/lib/model-policy.ts";

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
