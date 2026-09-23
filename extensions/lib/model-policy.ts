import { type Api, clampThinkingLevel, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Whether a session runs on a Claude-family model. Claude Code's own subagent
 * conventions (`CLAUDE_CODE_SUBAGENT_MODEL`, `.claude/agents` model fields) are
 * honored across providers only on such sessions; elsewhere subagents stay on
 * the session's provider. Only provider/id are consulted, so a minimal model
 * shape suffices.
 */
export function isClaudeFamilyModel(model: { provider: string; id: string }): boolean {
	return model.provider === "anthropic" || /claude/i.test(model.id);
}

/**
 * Whether a model accepts image input, from pi's catalog `input` modality
 * (`("text" | "image")[]`). PDFs count as image input too: pi's Read tool renders
 * PDF pages visually, so a model that cannot take images cannot read a PDF a
 * subagent opens either. A model whose modality is unknown (undefined `input`, as
 * on some opaque/self-hosted providers, or a minimal test stub, or no model at all) reads as
 * text-only here — the safe direction for a gate that only ever ADDS a
 * requirement, never relaxes one. See `working-docs/decisions/model-policy.md`.
 */
export function supportsImageInput(model: { input?: readonly string[] } | undefined): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}

export type ProviderPolicyKind = "direct" | "hosted" | "gateway" | "opaque";

export interface ProviderPolicy {
	kind: ProviderPolicyKind;
	/** Fixed profile for direct vendors and stable hosted catalogs. */
	profile?: string;
}

const direct = (profile: string): ProviderPolicy => ({ kind: "direct", profile });
const hosted = (profile?: string): ProviderPolicy => ({ kind: "hosted", profile });
const gateway = (): ProviderPolicy => ({ kind: "gateway" });
const opaque = (): ProviderPolicy => ({ kind: "opaque" });

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
	// A cross-region inference profile prefixes the vendor with its geography
	// (`us.`, `jp.`, `us-gov.`, …): a first segment that is not a vendor, followed
	// by one that is. Reading it that way needs no list of AWS region codes.
	const [first, second] = model.id.split(".");
	const regional = second !== undefined && !canonicalVendor(first) && canonicalVendor(second) !== undefined;
	const geography = regional ? first.toLowerCase() : "in-region";
	const raw = regional ? model.id.slice(first.length + 1) : model.id;
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

const UNSUITABLE_VARIANT = /:(batch|free|online|thinking)$/i;

/**
 * The id without OpenRouter's `~` redirect-alias marker and without a
 * `:batch`-style endpoint variant — the spelling the name rules, the facts
 * table and the capability index all key on (`~deepseek/deepseek-v4-flash-latest`
 * → `deepseek/deepseek-v4-flash-latest`, `gpt-5-mini:batch` → `gpt-5-mini`).
 */
export function baseModelId(id: string): string {
	return (id.startsWith("~") ? id.slice(1) : id).replace(/:[a-z]+$/i, "");
}

/** Whether the id carries a redirect marker or endpoint variant (`baseModelId` would change it). */
export function isAliasOrVariantId(id: string): boolean {
	return baseModelId(id) !== id;
}

/**
 * Automatic selection excludes endpoint variants with the wrong execution shape,
 * and OpenRouter's `~vendor/family-latest` redirect aliases ("always redirects to
 * the latest model in the family"): the model behind one moves without notice,
 * so it has no stable identity to tier, date or price — and the classifier is a
 * permission boundary. The alias stays available by hand (/model, an explicit
 * `subagentModel` / `classifierModel` setting).
 */
export function isSelectableVariant(model: Model<Api>): boolean {
	return !UNSUITABLE_VARIANT.test(model.id) && !model.id.startsWith("~");
}

/** One day in milliseconds, for the release-date arithmetic in model-facts.ts and capability-index.ts. */
export const DAY_MS = 86_400_000;

/** Non-positive values are catalog sentinels/unpriced, not evidence of being free. */
export function pricedInput(model: Model<Api>): number | undefined {
	const input = model.cost?.input;
	return typeof input === "number" && input > 0 ? input : undefined;
}

/** A dated snapshot id (`claude-haiku-4-5-20251001`): the trailing `-YYYYMMDD` marks a pinned alias of an undated model. */
export function isDatedModelId(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

/**
 * The id with a trailing snapshot date removed: `-YYYYMMDD` (Anthropic, OpenAI)
 * or `-MMDD` (DeepSeek's `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`; the
 * four digits must be a real month and day, so a `-2411`-style version tag is
 * left alone). The id itself when it carries no such suffix.
 */
export function stripSnapshotDate(id: string): string {
	if (isDatedModelId(id)) return id.slice(0, -9);
	const short = id.match(/-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
	return short ? id.slice(0, -5) : id;
}

/** Whether the id ends in a snapshot date of either shape (`stripSnapshotDate` would change it). */
export function isSnapshotDatedId(id: string): boolean {
	return stripSnapshotDate(id) !== id;
}

/**
 * Whether `model` is a dated snapshot whose undated alias is also present in
 * `pool` — the row a listing collapses so the same model is not offered twice.
 * Exact: the alias must be the id minus its date, so `deepseek-v4-flash-vision-exp`
 * is never read as a snapshot of `deepseek-v4-flash`.
 */
export function isDatedDuplicate(model: { id: string }, pool: ReadonlyArray<{ id: string }>): boolean {
	const alias = stripSnapshotDate(model.id);
	return alias !== model.id && pool.some((other) => other.id === alias);
}

/** The canonical `provider/id` spec — one source of truth for the string form. */
export function modelSpec(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** Whether a stamped-default setting was set for a provider this session has since left. */
export function isStaleContainmentStamp(
	setForContainment: string | undefined,
	sessionModel: { provider: string; id: string } | undefined,
): boolean {
	return setForContainment !== (sessionModel ? modelIdentity(sessionModel as Model<Api>).containment : undefined);
}

/** Whether an explicit model leaves the session's provider/route/family boundary. */
export function crossesProvider(model: Model<Api>, sessionModel: Model<Api>): boolean {
	if (model.provider !== sessionModel.provider) return true;
	return modelIdentity(model).containment !== modelIdentity(sessionModel).containment;
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

/**
 * The thinking level to send on a one-shot `completeSimple` call that would
 * rather run with thinking OFF (classifier, setup drafting, recap, readers).
 *
 * `undefined` = the model supports off — omit `reasoning`, pi disables thinking
 * explicitly, the request stays exactly as before. A level = the model cannot
 * disable thinking (catalog `thinkingLevelMap.off: null`, e.g. Gemini 3.6+
 * Flash); omitting `reasoning` makes the provider 400 ("Reasoning is mandatory
 * for this endpoint and cannot be disabled"), so send the lowest level the
 * model supports instead.
 */
export function forcedReasoningLevel(model: Model<Api>): ThinkingLevel | undefined {
	const clamped = clampThinkingLevel(model, "off");
	return clamped === "off" ? undefined : (clamped as ThinkingLevel);
}

/**
 * Provider error saying thinking cannot be disabled — the reactive net for a
 * model whose catalog entry LACKS the `thinkingLevelMap.off: null` marker
 * (OpenRouter entries, hand-added models newer than the bundled catalog).
 * A false positive only costs one retry with minimal thinking.
 */
export function isReasoningMandatoryError(message: string): boolean {
	return /(reasoning|thinking)[^.]*\b(mandatory|cannot be disabled|can't be disabled|must be enabled|is required)\b/i.test(message);
}

/** The level to retry with after isReasoningMandatoryError: the lowest real level the model supports. */
export function reasoningRetryLevel(model: Model<Api>): ThinkingLevel {
	const clamped = clampThinkingLevel(model, "minimal");
	return clamped === "off" ? "minimal" : (clamped as ThinkingLevel);
}

/**
 * Run a one-shot `completeSimple`-style call that wants thinking OFF, handling
 * the models that can't. The proactive path ({@link forcedReasoningLevel}) sends
 * a level up front for catalog-marked models; the reactive path catches a
 * provider's mandatory-thinking 400 ({@link isReasoningMandatoryError}) for the
 * metadata gaps and retries ONCE at the model's floor. `call` receives the level
 * to send (undefined = omit `reasoning`) and is invoked at most twice.
 *
 * `learned` optionally memoizes the reactive result per `provider/id` across
 * calls, so a repeatedly-called site (the web-fetch reader) pays the failed
 * round-trip once, not every call. Omit it for one-off callers.
 *
 * `onUsage` receives the final reply's `usage` once per invocation — this is the
 * single choke point for the reader-style one-shots (web-fetch, recap, setup),
 * so instrumenting it here reports their cost to the footer without each call
 * site having to remember to.
 */
export async function withReasoningFallback<R extends { stopReason: string; errorMessage?: string; usage?: unknown }>(
	model: Model<Api>,
	call: (reasoning: ThinkingLevel | undefined) => Promise<R>,
	learned?: Map<string, ThinkingLevel>,
	onUsage?: (usage: unknown) => void,
): Promise<R> {
	const key = `${model.provider}/${model.id}`;
	const reasoning = learned?.get(key) ?? forcedReasoningLevel(model);
	let result = await call(reasoning);
	if (result.stopReason === "error" && !reasoning && isReasoningMandatoryError(result.errorMessage ?? "")) {
		const level = reasoningRetryLevel(model);
		learned?.set(key, level);
		result = await call(level);
	}
	onUsage?.(result.usage);
	return result;
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
