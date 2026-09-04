/**
 * context-management extension — asks Anthropic to drop old thinking blocks.
 *
 * Claude Code sends `context_management: { edits: [{ type: "clear_thinking_20251015",
 * keep: "all" }] }` on every request, which keeps long sessions from carrying
 * every past reasoning block. pi does not, so a long One Code session
 * accumulates more context than Claude Code would.
 *
 * Two things the parameter needs, both found empirically against the live API
 * (2026-08-05, api.anthropic.com):
 *
 * - The `anthropic-beta: context-management-2025-06-27` header, or the body
 *   param 400s with "context_management: Extra inputs are not permitted".
 *   Setting the header from `before_provider_headers` REPLACES the value pi
 *   computes at client creation (extension headers merge last), so we must
 *   rebuild pi's own beta list and append ours — see anthropicBetas(). That
 *   replicates pi-ai's createClient logic: OAuth identity betas, fine-grained
 *   tool streaming for models without eager input streaming, interleaved
 *   thinking for non-adaptive models, and server-side fallback for models with
 *   `compat.allowedFallbackModels` (pi also puts a `fallbacks` body field on
 *   those, which 400s if this beta is missing). Re-check on pi upgrades.
 *
 * - `thinking` enabled or an adaptive-thinking model, or the API 400s with
 *   "`clear_thinking_20251015` strategy requires `thinking` to be enabled or
 *   adaptive". The payload hook checks before attaching the edit.
 *
 * ON BY DEFAULT for first-party Anthropic (provider `anthropic`,
 * api.anthropic.com) — verified there, and Claude Code sends it on every
 * request. OFF everywhere else: Bedrock takes `anthropic_beta` in the body,
 * not the header, and proxies may strip unknown params — a rejected parameter
 * fails every request. `CC_CLEAR_THINKING=0` forces it off; `=1` forces it on
 * for an anthropic-messages endpoint you have confirmed accepts it.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { looksLikeAnthropicRequest } from "../lib/anthropic-payload.ts";
import { CACHE_RETENTION_ENV, mainSessionCacheRetention } from "../lib/cache-retention.ts";

const CLEAR_THINKING_EDIT = { type: "clear_thinking_20251015", keep: "all" };
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

// pi-ai's own beta features (anthropic-messages.ts, v0.83) — rebuilt here
// because our header value replaces the one pi computes.
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
// Newer pi versions add a `fallbacks` body field for models whose compat
// carries `allowedFallbackModels` (server-side fallback, e.g. opus-5 →
// opus-4-8), gated on this beta. Because we overwrite the whole header, we must
// re-add the beta whenever pi added the body field, or the API 400s with
// "fallbacks: Extra inputs are not permitted" (verified live, api.anthropic.com
// 2026-09-01). Mirrors pi's shouldUseServerSideFallbackBeta.
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicModelCompat {
	forceAdaptiveThinking?: boolean;
	supportsEagerToolInputStreaming?: boolean;
	allowedFallbackModels?: unknown[];
}

/** pi's beta list for this model/auth, with the context-management beta appended. */
export function anthropicBetas(oauth: boolean, compat: AnthropicModelCompat | undefined): string {
	const betas: string[] = [];
	if (oauth) betas.push(...OAUTH_BETAS);
	// pi sends this only when tools are present; we always register tools.
	if (compat?.supportsEagerToolInputStreaming === false) betas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	if (compat?.forceAdaptiveThinking !== true) betas.push(INTERLEAVED_THINKING_BETA);
	// pi puts a `fallbacks` body field on these models; the beta must ride along.
	if ((compat?.allowedFallbackModels?.length ?? 0) > 0) betas.push(SERVER_SIDE_FALLBACK_BETA);
	betas.push(CONTEXT_MANAGEMENT_BETA);
	return betas.join(",");
}

// The payload predicate lives in lib (pure, shared with compaction and
// tool-search); re-exported so existing importers keep working.
export { looksLikeAnthropicRequest } from "../lib/anthropic-payload.ts";

/** The edit is rejected unless thinking is enabled or the model is adaptive. */
export function clearThinkingApplies(payload: Record<string, unknown>, forceAdaptiveThinking: boolean): boolean {
	return payload.thinking !== undefined || forceAdaptiveThinking;
}

export function withClearThinking(payload: Record<string, unknown>): Record<string, unknown> {
	const existing = payload.context_management as { edits?: unknown[] } | undefined;
	if (existing?.edits?.some((edit) => (edit as { type?: string })?.type === CLEAR_THINKING_EDIT.type)) {
		return payload;
	}
	return {
		...payload,
		context_management: { edits: [...(existing?.edits ?? []), CLEAR_THINKING_EDIT] },
	};
}

/** mtime cache: this runs on every provider request, the hottest path there is. */
let authCache: { mtimeMs: number; oauth: boolean } | undefined;

/** OAuth logins need pi's identity betas kept in the header we overwrite. */
export function isAnthropicOAuth(): boolean {
	// getAgentDir() honours PI_CODING_AGENT_DIR, so an isolated one-code app
	// reads its own auth.json rather than ~/.pi's.
	const path = join(getAgentDir(), "auth.json");
	try {
		const mtimeMs = statSync(path).mtimeMs;
		const cached = authCache;
		if (cached && cached.mtimeMs === mtimeMs) return cached.oauth;
		const auth = JSON.parse(readFileSync(path, "utf8"));
		const entry = auth?.anthropic;
		const oauth = entry?.type === "oauth" || typeof entry?.refresh === "string";
		authCache = { mtimeMs, oauth };
		return oauth;
	} catch {
		authCache = undefined;
		return false;
	}
}

interface AnthropicishModel {
	api?: string;
	provider?: string;
	baseUrl?: string;
	compat?: AnthropicModelCompat;
}

/**
 * Default-on only where verified: first-party Anthropic. The env var overrides
 * both ways so a proxy user can opt in and anyone can opt out. Checked per
 * request because the model can change mid-session.
 */
export function clearThinkingEnabled(flag: string | undefined, model: AnthropicishModel | undefined): boolean {
	if (model?.api !== "anthropic-messages") return false;
	if (flag === "0") return false;
	if (flag === "1") return true;
	return model.provider === "anthropic" && (model.baseUrl ?? "").includes("api.anthropic.com");
}

export default function contextManagementExtension(pi: ExtensionAPI) {
	const flag = () => process.env.CC_CLEAR_THINKING;

	// Prompt-cache TTL for the main session: one hour in the interactive modes,
	// the way Claude Code caches (a pause between turns no longer re-writes the
	// context); a `-p`/json run keeps pi's 5-minute default, and so do
	// in-process children (lib/cache-retention.ts). pi reads the variable per
	// request, so setting it here, before the first prompt, is early enough.
	pi.on("session_start", (_event, ctx) => {
		const value = mainSessionCacheRetention(ctx.mode, process.env[CACHE_RETENTION_ENV]);
		if (value) process.env[CACHE_RETENTION_ENV] = value;
	});

	pi.on("before_provider_headers", (event, ctx) => {
		const model = ctx.model as AnthropicishModel | undefined;
		if (!clearThinkingEnabled(flag(), model)) return;
		event.headers["anthropic-beta"] = anthropicBetas(isAnthropicOAuth(), model?.compat);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model as AnthropicishModel | undefined;
		if (!clearThinkingEnabled(flag(), model)) return undefined;
		if (!looksLikeAnthropicRequest(event.payload)) return undefined;
		const payload = event.payload as Record<string, unknown>;
		if (!clearThinkingApplies(payload, model?.compat?.forceAdaptiveThinking === true)) return undefined;
		return withClearThinking(payload);
	});
}
