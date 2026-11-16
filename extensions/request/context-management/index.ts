/**
 * context-management extension — asks Anthropic to KEEP old thinking blocks.
 *
 * Claude Code sends `context_management: { edits: [{ type: "clear_thinking_20251015",
 * keep: "all" }] }` on every request. Despite the edit's name, `keep: "all"` is
 * a cache preserver, not a trimmer: models that strip previous-turn thinking by
 * default (Haiku through 4.5, Sonnet <= 4.5, Opus <= 4.1) would otherwise
 * invalidate the messages cache at the first stripped block; with the edit the
 * API keeps every block and the cached prefix survives (Anthropic's docs: "keeps
 * all thinking blocks (maximizes cache hits)"). It does not reduce context. pi
 * does not send it, so a long One Code session on such a model would re-cache
 * its history every turn without this extension — do not "optimize" the
 * parameter away (findings §9, CACHE-REVIEW-2026-09-04 L1).
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
 * fails every request. `*_CLEAR_THINKING=0` forces it off; `=1` forces it on
 * for an anthropic-messages endpoint you have confirmed accepts it.
 */

import { knobValue } from "../../lib/profile/knobs.ts";
import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAnthropicOAuth } from "../../lib/request/anthropic-auth.ts";
import { looksLikeAnthropicRequest } from "../../lib/request/anthropic-payload.ts";
import { CACHE_RETENTION_ENV, mainSessionCacheRetention } from "../../lib/request/cache-retention.ts";
import {
	type AnthropicishModel,
	anthropicBetas,
	clearThinkingApplies,
	clearThinkingEnabled,
	withClearThinking,
} from "../../lib/request/context-management.ts";

function contextManagementExtension(pi: ExtensionAPI) {
	const flag = () => knobValue("CLEAR_THINKING");

	// Prompt-cache TTL for the main session: one hour in the interactive modes,
	// the way Claude Code caches (a pause between turns no longer re-writes the
	// context); a `-p`/json run keeps pi's 5-minute default, and so do
	// in-process children (lib/request/cache-retention.ts). pi reads the variable per
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

export default feature("context-management", contextManagementExtension);
