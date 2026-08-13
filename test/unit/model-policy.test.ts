import { describe, expect, it } from "vitest";
import {
	BUILTIN_PROVIDER_POLICIES,
	findRoleProfileModel,
	modelIdentity,
	modelsContainedToSession,
	ROLE_PROFILES,
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

	it("keeps every reviewed role profile short", () => {
		for (const [key, profile] of Object.entries(ROLE_PROFILES)) {
			expect(profile.classifier.length, `${key}:classifier`).toBeLessThanOrEqual(5);
			expect(profile.subagent.length, `${key}:subagent`).toBeLessThanOrEqual(5);
		}
	});

	it("marks opaque routers as session-only", () => {
		for (const provider of ["radius", "huggingface", "opencode", "opencode-go"]) {
			expect(BUILTIN_PROVIDER_POLICIES[provider]).toMatchObject({ kind: "opaque", dynamicSubagents: false });
		}
	});
});

describe("model identity and containment", () => {
	it("contains OpenRouter to the live model author and reuses a canonical profile", () => {
		const session = model("openrouter", "openai/gpt-5.6-sol", 5);
		const luna = model("openrouter", "openai/gpt-5.6-luna", 0.2);
		const haiku = model("openrouter", "anthropic/claude-haiku-4.5", 1);
		expect(modelIdentity(session)).toMatchObject({ profile: "openai", normalizedId: "gpt-5.6-sol" });
		expect(modelsContainedToSession([session, luna, haiku], session)).toEqual([session, luna]);
		expect(findRoleProfileModel([session, luna, haiku], session, "classifier")?.id).toBe("openai/gpt-5.6-luna");
	});

	it("normalizes dot and hyphen family spellings without a gateway catalog", () => {
		const session = model("openrouter", "anthropic/claude-fable-5", 10);
		const haiku = model("openrouter", "anthropic/claude-haiku-4.5", 1);
		expect(findRoleProfileModel([session, haiku], session, "classifier")?.id).toBe(haiku.id);
	});

	it("reuses canonical profiles within a Vercel creator namespace", () => {
		const session = model("vercel-ai-gateway", "x-ai/grok-4.5", 3);
		const worker = model("vercel-ai-gateway", "x-ai/grok-4.3", 0.3);
		const other = model("vercel-ai-gateway", "zai/glm-5-turbo", 0.2);
		expect(modelIdentity(session).profile).toBe("xai");
		expect(modelsContainedToSession([session, worker, other], session)).toEqual([session, worker]);
		expect(findRoleProfileModel([session, worker, other], session, "classifier")?.id).toBe(worker.id);
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
		expect(findRoleProfileModel([session, other], session, "subagent")).toBeUndefined();
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
		// Sonnet-class leads the classifier profile now, so a pool without a Sonnet
		// falls through to Haiku — which still exercises the US-region normalization
		// this test guards (the US-qualified id matches the `claude-haiku-4-5` family,
		// the EU-qualified one does not).
		expect(findRoleProfileModel([euHaiku, haiku], session, "classifier")?.id).toBe(haiku.id);
	});

	it("fails unknown custom providers closed", () => {
		const session = model("custom", "flagship", 10);
		const cheap = model("custom", "cheap", 0.01);
		expect(modelsContainedToSession([session, cheap], session)).toEqual([session]);
	});
});
