/**
 * Prompt-cache TTL policy: one hour for the interactive main session, the
 * provider's five-minute default for everything else.
 *
 * pi's only knob is the `PI_CACHE_RETENTION` env var: `long` puts Anthropic's
 * `cache_control.ttl: "1h"` on every breakpoint and `prompt_cache_retention:
 * "24h"` on OpenAI Responses/Completions (each gated by the model's compat
 * data); anything else leaves the provider's 5-minute default. An interactive
 * session pauses for minutes between turns, and every pause past five minutes
 * re-writes the whole context at 1.25x instead of reading it at 0.1x — Claude
 * Code puts `ttl: "1h"` on all its breakpoints for the same reason. A `-p` /
 * `--mode json` run is a tight loop whose requests are seconds apart, where the
 * 1h write (2x base input) never pays back against the 5m write (1.25x); so
 * are in-process children (subagents, workflow agents).
 *
 * pi reads the variable per request through `getProviderEnvValue(name, env)`,
 * which prefers the `env` the model runtime's `getAuth` returned over
 * `process.env`. That gives one lever at each level: the main session sets the
 * process default at `session_start` (see `mainSessionCacheRetention`), and the
 * shared child model runtime answers `getAuth` with `PI_CACHE_RETENTION=short`
 * merged into its env (`withShortCacheRetention`), so children fall back to the
 * provider default through pi's own gating — every provider, no payload shapes.
 */

export const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";

/** pi's `ctx.mode` values (not exported from the package). */
export type SessionMode = "tui" | "rpc" | "json" | "print";

/**
 * The `PI_CACHE_RETENTION` value the main session should run with, or undefined
 * to leave the environment alone: `long` for the interactive modes when the
 * user has not set the variable; a user's own value always wins; headless runs
 * keep pi's default.
 */
export function mainSessionCacheRetention(mode: SessionMode, current: string | undefined): string | undefined {
	if (current !== undefined && current !== "") return undefined;
	return mode === "tui" || mode === "rpc" ? "long" : undefined;
}

/** The slice of pi's ModelRuntime this wrapper touches. */
export interface AuthEnvRuntime {
	getAuth(target: unknown, overrides?: unknown): Promise<{ env?: Record<string, string> } | undefined>;
}

/**
 * Make a model runtime answer every `getAuth` with `PI_CACHE_RETENTION=short`
 * in its env (credential env entries are kept), so each request pi prepares
 * through it uses the provider's default cache TTL whatever the process-wide
 * variable says. Mutates and returns the same runtime; idempotent.
 */
export function withShortCacheRetention<T extends AuthEnvRuntime>(runtime: T): T {
	const getAuth = runtime.getAuth.bind(runtime);
	runtime.getAuth = async (target: unknown, overrides?: unknown) => {
		const result = await getAuth(target, overrides);
		if (!result) return result;
		return { ...result, env: { ...(result.env ?? {}), [CACHE_RETENTION_ENV]: "short" } };
	};
	return runtime;
}
