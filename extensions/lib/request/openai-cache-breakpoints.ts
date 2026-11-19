/**
 * OpenAI's explicit prompt-cache breakpoints (`prompt_cache_breakpoint` on an
 * input part), on the Responses models whose pi catalog entry sets
 * `compat.supportsExplicitPromptCacheMode` (GPT-5.6 and later). Their implicit
 * cache reuses a prefix only at an eligible item's end (findings §89, §95), so
 * One Code marks what it must reuse: the auto-mode classifier's history
 * (safety/permissions/auto-mode/cache.ts) and the main request's context
 * message (lib/request/system-role.ts withSystemRoleContext). Pure.
 */

/** The breakpoint as an input part carries it; frozen, since every marked part shares it. */
export const RESPONSES_BREAKPOINT = Object.freeze({ mode: "explicit" } as const);

/** Whether `model` takes explicit breakpoints: an OpenAI Responses model with pi's explicit-cache flag. */
export function takesExplicitCacheBreakpoints(model: { api: string; compat?: unknown }): boolean {
	const compat = model.compat as { supportsExplicitPromptCacheMode?: unknown } | undefined;
	return model.api === "openai-responses" && compat?.supportsExplicitPromptCacheMode === true;
}

/**
 * Whether the main request's context message carries a breakpoint: a model
 * that takes one, not on Sign in with ChatGPT (untested there; `auth` is read
 * only for such a model, lib/request/anthropic-auth.ts authKind), and not when
 * pi-ai asked for explicit mode, its "no caching".
 */
export function contextBreakpoint(model: { api: string; compat?: unknown }, payload: Record<string, unknown>, auth: () => "oauth" | "chatgpt" | "key"): boolean {
	if (!takesExplicitCacheBreakpoints(model) || auth() === "chatgpt") return false;
	return (payload.prompt_cache_options as { mode?: unknown } | undefined)?.mode !== "explicit";
}
