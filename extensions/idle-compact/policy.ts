/**
 * Idle compaction's rules, pure (no pi imports; index.ts is the wiring).
 *
 * Claude Code 2.1.289 compacts an idle main session shortly before its
 * one-hour prompt cache expires: the compaction reads the warm cache at the
 * cached rate, where the user's next prompt after expiry would write the whole
 * context to the cache again. Its rules, matched here:
 *   - a timer is armed after every main-session request whose cache carries a
 *     one-hour TTL, for 90% of the hour (`fireAtFraction`), so 54 minutes;
 *   - when it fires, the first refusal below that applies wins, in Claude
 *     Code's order: off, compaction off, prefix changed, lapsed (fired more
 *     than 60 s late, or the cache is no longer warm), small (under 200,000
 *     context tokens), near the rate limit; then the host's: busy (a turn
 *     running or messages queued), present (a keystroke in the last 60 s);
 *   - otherwise it compacts with no instructions and shows
 *     "Compacted while idle, before the prompt cache expired".
 * Claude Code's `not_one_hour` and `newer_request` refusals need no check
 * here: every request replaces the timer, and only a one-hour request arms one.
 *
 * Claude Code ships it behind a server flag that defaults off; One Code turns
 * it on, with `CC_IDLE_COMPACT=0` to opt out (working-docs/decisions/caching.md,
 * "Idle compaction before the cache expires").
 */

import type { TimerOps } from "../lib/timer-ops.ts";

/** The notice Claude Code appends after an idle compaction. */
export const IDLE_COMPACT_NOTICE = "Compacted while idle, before the prompt cache expired";

/** The one-hour cache lifetime idle compaction is armed for. */
export const ONE_HOUR_MS = 60 * 60_000;
/** Claude Code's defaults (`minTokens` 200,000, `fireAtFraction` 0.9). */
export const DEFAULT_MIN_TOKENS = 200_000;
export const DEFAULT_FIRE_AT_FRACTION = 0.9;
/** A timer that fires later than this may find the cache gone (the machine slept). */
export const LATE_MS = 60_000;
/** A keystroke this recent means the user is present: no compaction under them. */
export const PRESENCE_MS = 60_000;

export interface IdleCompactConfig {
	enabled: boolean;
	minTokens: number;
	/** Delay from the request to the fire; undefined means `fireAtFraction` of the hour. */
	delayMs?: number;
}

/**
 * The config from the environment: `CC_IDLE_COMPACT=0` turns it off;
 * `CC_IDLE_COMPACT_MIN_TOKENS` and `CC_IDLE_COMPACT_DELAY_MS` override the
 * threshold and the fire delay, for live testing (the delay stays under the
 * hour, at least one second).
 */
export function idleCompactConfig(env: Record<string, string | undefined>): IdleCompactConfig {
	const minTokens = Number(env.CC_IDLE_COMPACT_MIN_TOKENS);
	const delayMs = Number(env.CC_IDLE_COMPACT_DELAY_MS);
	return {
		enabled: env.CC_IDLE_COMPACT !== "0",
		minTokens: Number.isFinite(minTokens) && minTokens >= 1 ? minTokens : DEFAULT_MIN_TOKENS,
		...(Number.isFinite(delayMs) && delayMs >= 1000 && delayMs < ONE_HOUR_MS ? { delayMs } : {}),
	};
}

/** Why a fire did not compact. */
export type IdleRefusal = "disabled" | "compaction_off" | "prefix_changed" | "lapsed" | "small" | "near_limit" | "busy" | "present";

/** The one-hour main-session request a timer was armed for. */
export interface ArmedRequest {
	/** When it went out (ms). */
	at: number;
	/** `provider/id` and thinking level it ran with: the cache's identity. */
	model: string | undefined;
	thinking: string | undefined;
}

/** What the session looks like when the timer fires. */
export interface FireProbe {
	now: number;
	/** When the timer was due. */
	dueAt: number;
	config: IdleCompactConfig;
	/** pi's auto-compaction setting, and One Code's cache-reading compaction (CC_COMPACTION). */
	compactionOn: boolean;
	model: string | undefined;
	thinking: string | undefined;
	/** The armed request's reply reported cache reads or writes. */
	warm: boolean;
	contextTokens: number;
	/** Anthropic's `anthropic-ratelimit-unified-status` from the latest response, if any. */
	rateLimitStatus: string | undefined;
	idle: boolean;
	lastInteractionAt: number | undefined;
}

/** The first refusal that applies, in Claude Code's order, or null to compact. */
export function idleRefusal(armed: ArmedRequest, probe: FireProbe): IdleRefusal | null {
	if (!probe.config.enabled) return "disabled";
	if (!probe.compactionOn) return "compaction_off";
	if (probe.model !== armed.model || probe.thinking !== armed.thinking) return "prefix_changed";
	// The expiry half only trips under a CC_IDLE_COMPACT_DELAY_MS near the hour:
	// at the default 54 minutes the lateness check trips first.
	if (probe.now - probe.dueAt > LATE_MS || !probe.warm || probe.now >= armed.at + ONE_HOUR_MS) return "lapsed";
	if (probe.contextTokens < probe.config.minTokens) return "small";
	if (probe.rateLimitStatus !== undefined && probe.rateLimitStatus !== "allowed") return "near_limit";
	if (!probe.idle) return "busy";
	if (probe.lastInteractionAt !== undefined && probe.now - probe.lastInteractionAt < PRESENCE_MS) return "present";
	return null;
}

/**
 * One pending timer for the latest one-hour request. Each `arm` replaces it;
 * `cancel()` drops it when the session's last request stops being a one-hour
 * one, or there is none (a new session, a compaction, a branch switch).
 */
export class IdleCompactTimer {
	private handle: unknown;

	constructor(
		private readonly timer: TimerOps,
		private readonly now: () => number,
		private readonly config: () => IdleCompactConfig,
		private readonly onFire: (armed: ArmedRequest, dueAt: number, config: IdleCompactConfig) => void,
	) {}

	arm(request: ArmedRequest): void {
		this.cancel();
		const config = this.config();
		if (!config.enabled) return;
		const dueAt = request.at + (config.delayMs ?? ONE_HOUR_MS * DEFAULT_FIRE_AT_FRACTION);
		this.handle = this.timer.set(() => {
			this.handle = undefined;
			this.onFire(request, dueAt, config);
		}, Math.max(0, dueAt - this.now()));
	}

	cancel(): void {
		if (this.handle !== undefined) this.timer.clear(this.handle);
		this.handle = undefined;
	}

	get pending(): boolean {
		return this.handle !== undefined;
	}
}
