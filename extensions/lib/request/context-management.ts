/**
 * The context-management request policy, pure (no pi imports): when the
 * `clear_thinking_20251015` edit applies, the edit itself, and the
 * `anthropic-beta` header that must ride with it. The extension
 * (`request/context-management/index.ts`, whose header holds the why and the
 * live findings) applies it to the session's requests; side calls and
 * compaction use `sessionRequestHeaders` to match them.
 */
import { acceptsAnthropicWire } from "../models/model-policy.ts";
import { knobValue } from "../profile/knobs.ts";
import { isAnthropicOAuth } from "./anthropic-auth.ts";

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
// The same trap for models whose compat carries `supportsMidConvoEffort` (Opus 5,
// Opus 5.5, Fable 5.1): pi inserts `role: "system"` messages holding an
// `output_config`, and without these two betas the API 400s with
// "messages.1.output_config: Extra inputs are not permitted" (verified live,
// 2026-09-23). `test/unit/context-management.test.ts` fails when the installed
// pi-ai declares a beta this list does not account for.
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

export interface AnthropicModelCompat {
	forceAdaptiveThinking?: boolean;
	supportsEagerToolInputStreaming?: boolean;
	allowedFallbackModels?: unknown[];
	supportsMidConvoEffort?: boolean;
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
	if (compat?.supportsMidConvoEffort === true) betas.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
	betas.push(CONTEXT_MANAGEMENT_BETA);
	return betas.join(",");
}

/**
 * The edit is rejected unless thinking is on: enabled or adaptive in the
 * request, or left to an adaptive model's default. A request that turns
 * thinking off (`{ type: "disabled" }`, "off" effort on Opus 5 and Haiku 5.5)
 * takes no edit, adaptive model or not (round-2 review H3).
 */
export function clearThinkingApplies(payload: Record<string, unknown>, forceAdaptiveThinking: boolean): boolean {
	const type = (payload.thinking as { type?: unknown } | undefined)?.type;
	if (type === undefined) return payload.thinking === undefined && forceAdaptiveThinking;
	return type === "enabled" || type === "adaptive";
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

export interface AnthropicishModel {
	api?: string;
	provider?: string;
	baseUrl?: string;
	compat?: AnthropicModelCompat;
}

/**
 * Default-on only where verified: first-party Anthropic, or a provider whose
 * profile entry lists `context-management`. The env var overrides
 * both ways so a proxy user can opt in and anyone can opt out. Checked per
 * request because the model can change mid-session.
 */
export function clearThinkingEnabled(flag: string | undefined, model: AnthropicishModel | undefined): boolean {
	if (model?.api !== "anthropic-messages") return false;
	if (flag === "0") return false;
	if (flag === "1") return true;
	if (model.provider === "anthropic") return (model.baseUrl ?? "").includes("api.anthropic.com");
	return acceptsAnthropicWire(model, "context-management");
}

/**
 * The extra headers a side call on the session model needs so its request
 * matches the session's: where clear_thinking is on, the beta header the
 * session's requests carry (a side call bypasses our header hook). pi merges
 * them over the credential's own headers.
 */
export function sessionRequestHeaders(
	model: { api?: string; provider?: string; baseUrl?: string; compat?: unknown } | undefined,
): Record<string, string> | undefined {
	// compat is a provider union; clearThinkingEnabled only passes Anthropic models.
	const anthropic = model as AnthropicishModel | undefined;
	if (!clearThinkingEnabled(knobValue("CLEAR_THINKING"), anthropic)) return undefined;
	return { "anthropic-beta": anthropicBetas(isAnthropicOAuth(), anthropic?.compat) };
}
