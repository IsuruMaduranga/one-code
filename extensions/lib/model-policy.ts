import type { Api, Model } from "@earendil-works/pi-ai";

/** The two automatic model-selection jobs have different capability floors. */
export type ModelRole = "classifier" | "subagent";

export interface RoleProfile {
	/** Vetted, small-but-capable models. Price alone never adds to this list. */
	classifier: readonly string[];
	/** Economical models suitable for delegated coding/reasoning work. */
	subagent: readonly string[];
}

/**
 * Short family lists, not catalogs. Broad gateways apply these to their live
 * authenticated catalog after containment; they never get an OpenRouter-sized
 * hardcoded list. Reviewed against official provider docs on 2026-08-06.
 */
export const ROLE_PROFILES: Readonly<Record<string, RoleProfile>> = {
	anthropic: {
		classifier: ["claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-4-6"],
		subagent: ["claude-sonnet-5", "claude-haiku-4-5", "claude-sonnet-4-6"],
	},
	openai: {
		classifier: ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
		subagent: ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.6-terra"],
	},
	google: {
		classifier: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"],
		subagent: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"],
	},
	xai: {
		classifier: ["grok-4.3", "grok-4.5"],
		subagent: ["grok-build-0.1", "grok-4.3", "grok-4.5"],
	},
	mistral: {
		classifier: ["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5"],
		subagent: ["mistral-small-2603", "mistral-medium-3.5", "codestral-latest"],
	},
	deepseek: {
		classifier: ["deepseek-v4-flash", "deepseek-v4-pro"],
		subagent: ["deepseek-v4-flash", "deepseek-v4-pro"],
	},
	zai: {
		classifier: ["glm-5-turbo", "glm-4.7", "glm-5.2", "glm-4.5-air", "glm-4-flash"],
		subagent: ["glm-5-turbo", "glm-4.7", "glm-5.2", "glm-4.5-air"],
	},
	moonshot: {
		classifier: ["kimi-k2.6", "kimi-k2.5"],
		subagent: ["kimi-k2.7-code", "kimi-k2.6", "kimi-k3"],
	},
	minimax: {
		classifier: ["MiniMax-M2.7", "MiniMax-M3"],
		subagent: ["MiniMax-M2.7", "MiniMax-M3"],
	},
	xiaomi: {
		classifier: ["mimo-v2.5", "mimo-v2-pro"],
		subagent: ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro"],
	},
	"ant-ling": {
		// The current pi catalog predates Ling 3.0. Flash remains opt-in: it has
		// not been calibrated as the approval boundary.
		classifier: ["Ling-2.6-1T", "Ring-2.6-1T"],
		subagent: ["Ling-2.6-1T", "Ring-2.6-1T", "Ling-2.6-flash"],
	},
	meta: {
		classifier: ["llama-3.3-70b", "llama-4-scout"],
		subagent: ["llama-4-scout", "llama-3.3-70b"],
	},
	amazon: {
		classifier: ["nova-2-lite", "nova-lite"],
		subagent: ["nova-2-lite", "nova-lite", "nova-pro"],
	},
	"host:nvidia": {
		classifier: ["nvidia/nvidia-nemotron-nano-9b-v2", "openai/gpt-oss-20b", "meta/llama-3.3-70b-instruct"],
		subagent: ["poolside/laguna-xs-2.1", "nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-20b"],
	},
	"host:groq": {
		classifier: ["openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
		subagent: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
	},
	"host:cerebras": {
		classifier: ["gpt-oss-120b", "zai-glm-4.7"],
		subagent: ["gpt-oss-120b", "zai-glm-4.7"],
	},
	"host:fireworks": {
		classifier: ["accounts/fireworks/models/deepseek-v4-flash", "accounts/fireworks/models/gpt-oss-20b"],
		subagent: ["accounts/fireworks/models/kimi-k2p7-code", "accounts/fireworks/models/gpt-oss-20b"],
	},
	"host:together": {
		classifier: ["Qwen/Qwen3.5-9B", "openai/gpt-oss-20b"],
		subagent: ["openai/gpt-oss-20b", "moonshotai/Kimi-K2.7-Code", "Qwen/Qwen3.5-9B"],
	},
	"host:baseten": {
		classifier: ["openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V4-Flash"],
		subagent: ["openai/gpt-oss-120b", "zai-org/GLM-5.2", "moonshotai/Kimi-K2.7-Code"],
	},
	"host:cloudflare-workers": {
		classifier: ["@cf/openai/gpt-oss-20b", "@cf/zai-org/glm-4.7-flash"],
		subagent: ["@cf/moonshotai/kimi-k2.7-code", "@cf/openai/gpt-oss-20b"],
	},
	"host:qwen-plan": {
		classifier: ["qwen3.6-flash", "deepseek-v4-flash", "qwen3.6-plus"],
		subagent: ["kimi-k2.7-code", "deepseek-v4-flash", "qwen3.7-plus", "qwen3.6-plus"],
	},
	"host:kimi-coding": {
		classifier: ["kimi-for-coding", "k3"],
		subagent: ["kimi-for-coding", "k3"],
	},
};

export type ProviderPolicyKind = "direct" | "hosted" | "gateway" | "opaque";

export interface ProviderPolicy {
	kind: ProviderPolicyKind;
	/** Fixed profile for direct vendors and stable hosted catalogs. */
	profile?: string;
	/** Whether a price-ranked subagent may follow the vetted profile. */
	dynamicSubagents: boolean;
}

const direct = (profile: string): ProviderPolicy => ({ kind: "direct", profile, dynamicSubagents: true });
const hosted = (profile?: string): ProviderPolicy => ({ kind: "hosted", profile, dynamicSubagents: true });
const gateway = (): ProviderPolicy => ({ kind: "gateway", dynamicSubagents: true });
const opaque = (): ProviderPolicy => ({ kind: "opaque", dynamicSubagents: false });

/**
 * Every built-in language-model provider in pi 0.84.0. Unknown/custom providers
 * get the opaque policy below, so a pi upgrade fails safe rather than widening
 * automatic routing.
 */
export const BUILTIN_PROVIDER_POLICIES: Readonly<Record<string, ProviderPolicy>> = {
	"amazon-bedrock": hosted(),
	"ant-ling": direct("ant-ling"),
	anthropic: direct("anthropic"),
	google: direct("google"),
	"google-vertex": direct("google"),
	openai: direct("openai"),
	"azure-openai-responses": direct("openai"),
	"openai-codex": direct("openai"),
	radius: opaque(),
	nvidia: hosted("host:nvidia"),
	deepseek: direct("deepseek"),
	"github-copilot": hosted(),
	xai: direct("xai"),
	groq: hosted("host:groq"),
	cerebras: hosted("host:cerebras"),
	openrouter: gateway(),
	"vercel-ai-gateway": gateway(),
	zai: direct("zai"),
	"zai-coding-cn": direct("zai"),
	mistral: direct("mistral"),
	minimax: direct("minimax"),
	"minimax-cn": direct("minimax"),
	moonshotai: direct("moonshot"),
	"moonshotai-cn": direct("moonshot"),
	huggingface: opaque(),
	fireworks: hosted("host:fireworks"),
	together: hosted("host:together"),
	baseten: hosted("host:baseten"),
	opencode: opaque(),
	"opencode-go": opaque(),
	"kimi-coding": direct("host:kimi-coding"),
	"cloudflare-workers-ai": hosted("host:cloudflare-workers"),
	"cloudflare-ai-gateway": gateway(),
	"qwen-token-plan": hosted("host:qwen-plan"),
	"qwen-token-plan-cn": hosted("host:qwen-plan"),
	xiaomi: direct("xiaomi"),
	"xiaomi-token-plan-cn": direct("xiaomi"),
	"xiaomi-token-plan-ams": direct("xiaomi"),
	"xiaomi-token-plan-sgp": direct("xiaomi"),
};

const VENDOR_ALIASES: Readonly<Record<string, string>> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	xai: "xai",
	"x-ai": "xai",
	mistral: "mistral",
	mistralai: "mistral",
	deepseek: "deepseek",
	zai: "zai",
	"z-ai": "zai",
	qwen: "host:qwen-plan",
	alibaba: "host:qwen-plan",
	moonshotai: "moonshot",
	minimax: "minimax",
	minimaxai: "minimax",
	xiaomi: "xiaomi",
	meta: "meta",
	"meta-llama": "meta",
	amazon: "amazon",
};

export interface ModelIdentity {
	/** Models may be switched automatically only when this key stays equal. */
	containment: string;
	/** Role profile to apply to normalizedId, when identity is reliable. */
	profile?: string;
	normalizedId: string;
	confidence: "exact" | "family" | "opaque";
}

const providerPolicy = (provider: string): ProviderPolicy => BUILTIN_PROVIDER_POLICIES[provider] ?? opaque();

function canonicalVendor(value: string): string | undefined {
	return VENDOR_ALIASES[value.toLowerCase()];
}

function prefixedIdentity(model: Model<Api>, prefix: string): ModelIdentity {
	const raw = model.id.startsWith("~") ? model.id.slice(1) : model.id;
	const slash = raw.indexOf("/");
	if (slash <= 0) {
		return { containment: `${model.provider}:opaque:${model.id}`, normalizedId: model.id, confidence: "opaque" };
	}
	const route = raw.slice(0, slash).toLowerCase();
	const normalizedId = raw.slice(slash + 1);
	return {
		containment: `${model.provider}:${prefix}:${route}`,
		profile: canonicalVendor(route),
		normalizedId,
		confidence: canonicalVendor(route) ? "family" : "opaque",
	};
}

function bareFamily(id: string): string | undefined {
	if (/^claude-/i.test(id)) return "anthropic";
	if (/^(gpt-|o\d(?:-|$))/i.test(id)) return "openai";
	if (/^(gemini-|gemma-)/i.test(id)) return "google";
	if (/^grok-/i.test(id)) return "xai";
	if (/^deepseek-/i.test(id)) return "deepseek";
	if (/^kimi-/i.test(id)) return "moonshot";
	if (/^minimax-/i.test(id)) return "minimax";
	if (/^glm-/i.test(id)) return "zai";
	if (/^qwen/i.test(id)) return "host:qwen-plan";
	if (/^mimo-/i.test(id)) return "xiaomi";
	if (/^llama-/i.test(id)) return "meta";
	return undefined;
}

function bedrockIdentity(model: Model<Api>): ModelIdentity {
	const geography = model.id.match(/^(us|eu|apac|au|global)\./i)?.[1]?.toLowerCase() ?? "in-region";
	const raw = model.id.replace(/^(?:us|eu|apac|au|global)\./i, "");
	const dot = raw.indexOf(".");
	if (dot <= 0 || raw.startsWith("arn:")) {
		return { containment: `${model.provider}:opaque:${model.id}`, normalizedId: model.id, confidence: "opaque" };
	}
	const vendor = raw.slice(0, dot).toLowerCase();
	const profile = canonicalVendor(vendor);
	return {
		containment: `${model.provider}:geography:${geography}:family:${vendor}`,
		profile,
		normalizedId: raw.slice(dot + 1).replaceAll("_", "-").replace(/-v\d(?::\d+)?$/i, ""),
		confidence: profile ? "family" : "opaque",
	};
}

function cloudflareGatewayIdentity(model: Model<Api>): ModelIdentity {
	if (model.id.startsWith("workers-ai/")) {
		return {
			containment: `${model.provider}:route:workers-ai`,
			profile: "host:cloudflare-workers",
			normalizedId: model.id.slice("workers-ai/".length),
			confidence: "exact",
		};
	}
	const api = String(model.api);
	const route = api === "anthropic-messages" ? "anthropic" : api.includes("openai") ? "openai" : undefined;
	if (!route) {
		return { containment: `${model.provider}:opaque:${model.id}`, normalizedId: model.id, confidence: "opaque" };
	}
	return {
		containment: `${model.provider}:route:${route}`,
		profile: route,
		normalizedId: model.id,
		confidence: "exact",
	};
}

/** Normalize privacy containment and model-family identity for one catalog row. */
export function modelIdentity(model: Model<Api>): ModelIdentity {
	const policy = providerPolicy(model.provider);
	if (policy.kind === "opaque") {
		return { containment: `${model.provider}:opaque:${model.id}`, normalizedId: model.id, confidence: "opaque" };
	}
	if (model.provider === "openrouter") return prefixedIdentity(model, "author");
	if (model.provider === "vercel-ai-gateway") return prefixedIdentity(model, "creator");
	if (model.provider === "cloudflare-ai-gateway") return cloudflareGatewayIdentity(model);
	if (model.provider === "amazon-bedrock") return bedrockIdentity(model);
	if (model.provider === "github-copilot") {
		const profile = bareFamily(model.id);
		return profile
			? { containment: `${model.provider}:family:${profile}`, profile, normalizedId: model.id, confidence: "family" }
			: { containment: `${model.provider}:opaque:${model.id}`, normalizedId: model.id, confidence: "opaque" };
	}
	return {
		containment: model.provider,
		profile: policy.profile,
		normalizedId: model.id,
		confidence: "exact",
	};
}

/**
 * Names of the known small-but-capable model families, best tier first. Too weak
 * to *choose* by — Groq and xAI carry none of them — but strong enough to
 * corroborate a choice price alone suggested, and to order tiers when several
 * cheap models qualify (mini-class ahead of nano/lite-class).
 */
const NAME_HINTS = [/haiku/i, /flash/i, /mini/i, /nano/i, /small/i, /lite/i, /instant/i, /sonnet/i];

/** Index into NAME_HINTS; NAME_HINTS.length means "no known small-model name". */
export function hintRank(model: Model<Api>): number {
	const index = NAME_HINTS.findIndex((pattern) => pattern.test(model.id));
	return index === -1 ? NAME_HINTS.length : index;
}

/** Whether the model's name carries one of the known small-model family words. */
export function hasSmallModelName(model: Model<Api>): boolean {
	return hintRank(model) < NAME_HINTS.length;
}

const UNSUITABLE_VARIANT = /:(batch|free|online|thinking)$/i;

/** Automatic selection excludes endpoint variants with the wrong execution shape. */
export function isSelectableVariant(model: Model<Api>): boolean {
	return !UNSUITABLE_VARIANT.test(model.id);
}

/** Non-positive values are catalog sentinels/unpriced, not evidence of being free. */
export function pricedInput(model: Model<Api>): number | undefined {
	const input = model.cost?.input;
	return typeof input === "number" && input > 0 ? input : undefined;
}

/** Models that automatic selection may consider without changing containment. */
export function modelsContainedToSession(available: Model<Api>[], sessionModel: Model<Api>): Model<Api>[] {
	const sessionIdentity = modelIdentity(sessionModel);
	return available.filter(
		(model) =>
			model.provider === sessionModel.provider &&
			isSelectableVariant(model) &&
			modelIdentity(model).containment === sessionIdentity.containment,
	);
}

function comparableId(value: string): string {
	return value.toLowerCase().replaceAll(".", "-").replaceAll("_", "-");
}

function matchesPrefix(model: Model<Api>, prefix: string): boolean {
	const id = comparableId(modelIdentity(model).normalizedId);
	const wanted = comparableId(prefix);
	return id === wanted || id.startsWith(wanted);
}

/** First live model matching a role's reviewed family order. */
export function findRoleProfileModel(
	available: Model<Api>[],
	sessionModel: Model<Api>,
	role: ModelRole,
	accept: (model: Model<Api>) => boolean = () => true,
): Model<Api> | undefined {
	const identity = modelIdentity(sessionModel);
	if (!identity.profile) return undefined;
	const prefixes = ROLE_PROFILES[identity.profile]?.[role] ?? [];
	const contained = modelsContainedToSession(available, sessionModel);
	for (const prefix of prefixes) {
		const wanted = comparableId(prefix);
		const exact = contained.find(
			(model) => comparableId(modelIdentity(model).normalizedId) === wanted && accept(model),
		);
		if (exact) return exact;
		const prefixed = contained.find((model) => matchesPrefix(model, prefix) && accept(model));
		if (prefixed) return prefixed;
	}
	return undefined;
}

export interface EconomicalModelChoice {
	model: Model<Api>;
	via: "profile" | "session";
}

/**
 * A vetted small-but-capable same-containment model within the session's
 * price ceiling, else the session model itself. Used for low-stakes one-shot
 * jobs over untrusted content (the web_fetch reader) — the content goes to
 * the model, so containment applies. Not used for compaction, which runs on
 * the session model to reuse the provider prompt cache.
 */
export function pickEconomicalContainedModel(
	available: Model<Api>[],
	sessionModel: Model<Api> | undefined,
): EconomicalModelChoice | undefined {
	if (!sessionModel) return undefined;
	const sessionPrice = pricedInput(sessionModel);
	const withinBudget = (model: Model<Api>) => {
		if (sessionPrice === undefined) return true;
		const price = pricedInput(model);
		return price === undefined || price <= sessionPrice;
	};
	const profiled = findRoleProfileModel(available, sessionModel, "classifier", withinBudget);
	return profiled ? { model: profiled, via: "profile" } : { model: sessionModel, via: "session" };
}

/** Whether price ranking is an acceptable subagent fallback for this session. */
export function allowsDynamicSubagentSelection(sessionModel: Model<Api>): boolean {
	const policy = providerPolicy(sessionModel.provider);
	if (!policy.dynamicSubagents) return false;
	return modelIdentity(sessionModel).confidence !== "opaque";
}

/** Resolve an explicit provider/id, bare id, or prefix. Explicit choices are not contained. */
export function findConfigured(available: Model<Api>[], configured: string): Model<Api> | undefined {
	const wanted = configured.trim();
	if (!wanted) return undefined;
	const qualified = available.find((model) => `${model.provider}/${model.id}` === wanted);
	if (qualified) return qualified;
	const byId = available.find((model) => model.id === wanted);
	if (byId) return byId;
	const slash = wanted.indexOf("/");
	if (slash > 0) {
		const provider = wanted.slice(0, slash);
		const idPrefix = wanted.slice(slash + 1);
		const inProvider = available.filter((model) => model.provider === provider);
		const exact = inProvider.find((model) => model.id === idPrefix);
		if (exact) return exact;
		const prefixed = inProvider.find((model) => model.id.startsWith(idPrefix));
		if (prefixed) return prefixed;
	}
	return available.find((model) => model.id.startsWith(wanted));
}
