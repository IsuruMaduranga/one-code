/**
 * context-management extension — asks Anthropic to drop old thinking blocks.
 *
 * Claude Code sends `context_management: { edits: [{ type: "clear_thinking_20251015",
 * keep: "all" }] }` on every request, which keeps long sessions from carrying
 * every past reasoning block. pi does not, so a long pi-claude-code session
 * accumulates more context than Claude Code would.
 *
 * OFF BY DEFAULT, opt in with `CC_CLEAR_THINKING=1`. The Anthropic API rejects
 * unknown top-level parameters, and this one is dated/versioned — if the account
 * or endpoint does not accept it, *every* request would fail. There is no
 * Anthropic credential in this environment to verify against, so shipping it on
 * by default would be exactly the kind of unverified landmine this project has
 * been removing. Enable it once you have confirmed it works on your account.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLEAR_THINKING_EDIT = { type: "clear_thinking_20251015", keep: "all" };

/** Anthropic Messages API shape: `messages` + `max_tokens`, and not an OpenAI `input`. */
export function looksLikeAnthropicRequest(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.messages)) return false;
	if ("input" in record) return false;
	const model = typeof record.model === "string" ? record.model : "";
	return model.includes("claude") || typeof record.max_tokens === "number";
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

export default function contextManagementExtension(pi: ExtensionAPI) {
	if (process.env.CC_CLEAR_THINKING !== "1") return;

	pi.on("before_provider_request", (event) => {
		if (!looksLikeAnthropicRequest(event.payload)) return undefined;
		return withClearThinking(event.payload as Record<string, unknown>);
	});
}
