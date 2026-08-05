/**
 * context-management extension — asks Anthropic to drop old thinking blocks.
 *
 * Claude Code sends `context_management: { edits: [{ type: "clear_thinking_20251015",
 * keep: "all" }] }` on every request, which keeps long sessions from carrying
 * every past reasoning block. pi does not, so a long pi-claude-code session
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
 *   replicates pi-ai's createClient logic (pinned v0.83): OAuth identity betas,
 *   fine-grained tool streaming for models without eager input streaming, and
 *   interleaved thinking for non-adaptive models. Re-check on pi upgrades.
 *
 * - `thinking` enabled or an adaptive-thinking model, or the API 400s with
 *   "`clear_thinking_20251015` strategy requires `thinking` to be enabled or
 *   adaptive". The payload hook checks before attaching the edit.
 *
 * OFF BY DEFAULT, opt in with `CC_CLEAR_THINKING=1`: a rejected parameter fails
 * every request, so this stays behind a flag until confirmed on your account.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLEAR_THINKING_EDIT = { type: "clear_thinking_20251015", keep: "all" };
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

// pi-ai's own beta features (anthropic-messages.ts, v0.83) — rebuilt here
// because our header value replaces the one pi computes.
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

export interface AnthropicModelCompat {
	forceAdaptiveThinking?: boolean;
	supportsEagerToolInputStreaming?: boolean;
}

/** pi's beta list for this model/auth, with the context-management beta appended. */
export function anthropicBetas(oauth: boolean, compat: AnthropicModelCompat | undefined): string {
	const betas: string[] = [];
	if (oauth) betas.push(...OAUTH_BETAS);
	// pi sends this only when tools are present; we always register tools.
	if (compat?.supportsEagerToolInputStreaming === false) betas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	if (compat?.forceAdaptiveThinking !== true) betas.push(INTERLEAVED_THINKING_BETA);
	betas.push(CONTEXT_MANAGEMENT_BETA);
	return betas.join(",");
}

/** Anthropic Messages API shape: `messages` + `max_tokens`, and not an OpenAI `input`. */
export function looksLikeAnthropicRequest(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.messages)) return false;
	if ("input" in record) return false;
	const model = typeof record.model === "string" ? record.model : "";
	return model.includes("claude") || typeof record.max_tokens === "number";
}

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

/** OAuth logins need pi's identity betas kept in the header we overwrite. */
function isAnthropicOAuth(): boolean {
	try {
		const auth = JSON.parse(readFileSync(join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"));
		const entry = auth?.anthropic;
		return entry?.type === "oauth" || typeof entry?.refresh === "string";
	} catch {
		return false;
	}
}

interface AnthropicishModel {
	api?: string;
	compat?: AnthropicModelCompat;
}

export default function contextManagementExtension(pi: ExtensionAPI) {
	if (process.env.CC_CLEAR_THINKING !== "1") return;

	pi.on("before_provider_headers", (event, ctx) => {
		const model = ctx.model as AnthropicishModel | undefined;
		if (model?.api !== "anthropic-messages") return;
		event.headers["anthropic-beta"] = anthropicBetas(isAnthropicOAuth(), model.compat);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!looksLikeAnthropicRequest(event.payload)) return undefined;
		const model = ctx.model as AnthropicishModel | undefined;
		const payload = event.payload as Record<string, unknown>;
		if (!clearThinkingApplies(payload, model?.compat?.forceAdaptiveThinking === true)) return undefined;
		return withClearThinking(payload);
	});
}
