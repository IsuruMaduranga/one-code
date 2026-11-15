/**
 * pi's prompt-cache warming, as One Code runs it (pure): warms during a run,
 * never between runs, as on pi 1.5.0.
 *
 * pi 1.5.1 changed its `cacheWarming` default from `"streaming"` to `"idle"`:
 * after a run settles it keeps re-sending the last request with a one-token
 * cap at 90% of the cache lifetime, for at most 30 minutes after that request,
 * when the expected saving (a fixed 15% chance that the user comes back in
 * time) clears $0.05 (pi-ai `cache-warming.ts`, coding-agent
 * `core/cache-warmer.ts`). A one-hour cache never reaches its 54-minute warm
 * inside that window; a five-minute cache (headless runs, children) warms
 * every 4.5 minutes while idle. Adopting idle warming is a separate decision
 * (working-docs/findings/85-pi-1.5.2.md); until then a warm decided while no
 * run is active is stopped through `cache_warming_decision`, which pi has
 * offered since 0.86, and a warm during a run keeps pi's own decision.
 *
 * The event does not name the phase, so the session's own state tells them
 * apart: pi starts warming from a session request and moves it to its idle
 * phase when the run settles, which is when `ctx.isIdle()` turns true.
 *
 * The veto replaces pi's default only. A user who set `cacheWarming` in pi's
 * global settings (the only scope pi reads it from, `getCacheWarmingMode`)
 * chose a mode, and pi's own decision stands for every warm.
 */

/** pi's `cacheWarming` modes; any other stored value is ignored by pi, as if unset. */
const CACHE_WARMING_MODES: readonly string[] = ["off", "streaming", "idle"];

/** The mode the user set in pi's global settings, or undefined when unset (or a value pi ignores). */
export function userCacheWarmingMode(globalSettings: { cacheWarming?: unknown } | undefined): string | undefined {
	const mode = globalSettings?.cacheWarming;
	return typeof mode === "string" && CACHE_WARMING_MODES.includes(mode) ? mode : undefined;
}

/** The `cache_warming_decision` result: stop an idle warm on pi's default, leave every other warm to pi. */
export function cacheWarmingVeto(sessionIdle: boolean, userMode: string | undefined): { action: "stop" } | undefined {
	return sessionIdle && userMode === undefined ? { action: "stop" } : undefined;
}
