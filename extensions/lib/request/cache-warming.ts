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
 */

/** The `cache_warming_decision` result: stop an idle warm, leave a warm during a run to pi. */
export function cacheWarmingVeto(sessionIdle: boolean): { action: "stop" } | undefined {
	return sessionIdle ? { action: "stop" } : undefined;
}
