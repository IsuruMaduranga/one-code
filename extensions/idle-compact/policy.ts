/**
 * Idle compaction's rules, pure (no pi imports; index.ts is the wiring).
 *
 * Claude Code 2.1.289 compacts an idle main session shortly before its
 * one-hour prompt cache expires: the compaction reads the warm cache at the
 * cached rate, where the user's next prompt after expiry would write the whole
 * context to the cache again. Its rules, matched here:
 *   - a timer is armed after every main-session request whose cache carries a
 *     one-hour TTL, for 90% of the time left (`fireAtFraction`), so 54 minutes;
 *   - when it fires, the first refusal below that applies wins, in Claude
 *     Code's order: off, compaction off, prefix changed, not one hour, lapsed
 *     (fired more than 60 s late, or the cache is no longer warm), small (under
 *     200,000 context tokens), a newer request, near the rate limit; then the
 *     host's: busy (a turn running or messages queued), present (a keystroke in
 *     the last 60 s);
 *   - otherwise it compacts with no instructions and shows
 *     "Compacted while idle, before the prompt cache expired".
 *
 * Claude Code ships it behind a server flag that defaults off; One Code turns
 * it on, with `CC_IDLE_COMPACT=0` to opt out (working-docs/decisions/caching.md,
 * "Idle compaction before the cache expires").
 */

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
	/** Delay from the request to the fire; undefined means `fireAtFraction` of the cache lifetime. */
	delayMs?: number;
}

/**
 * The config from the environment: `CC_IDLE_COMPACT=0` turns it off;
 * `CC_IDLE_COMPACT_MIN_TOKENS` and `CC_IDLE_COMPACT_DELAY_MS` override the
 * threshold and the fire delay, for live testing (the delay stays under the
 * cache lifetime, at least one second).
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

/**
 * The cache TTL a provider request body asks for: "1h" when any cache
 * breakpoint carries `ttl: "1h"` (pi's long retention on Anthropic), "5m" for
 * breakpoints without it, undefined for a body with none (OpenAI's automatic
 * caching, whose lifetime is not ours to time).
 */
export function requestCacheTtl(payload: unknown): "1h" | "5m" | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const body = payload as { system?: unknown; tools?: unknown; messages?: unknown };
	let found: "5m" | undefined;
	const check = (block: unknown): boolean => {
		const control = (block as { cache_control?: { ttl?: unknown } } | null)?.cache_control;
		if (!control || typeof control !== "object") return false;
		if (control.ttl === "1h") return true;
		found = "5m";
		return false;
	};
	const blocks = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
	for (const block of blocks(body.system)) if (check(block)) return "1h";
	for (const tool of blocks(body.tools)) if (check(tool)) return "1h";
	for (const message of blocks(body.messages)) {
		if (check(message)) return "1h";
		for (const block of blocks((message as { content?: unknown } | null)?.content)) if (check(block)) return "1h";
	}
	return found;
}

/** Why a fire did not compact. */
export type IdleRefusal =
	| "disabled"
	| "compaction_off"
	| "prefix_changed"
	| "not_one_hour"
	| "lapsed"
	| "small"
	| "newer_request"
	| "near_limit"
	| "busy"
	| "present";

/** The main-session request a timer was armed for. */
export interface ArmedRequest {
	/** When it went out (ms). */
	at: number;
	ttlMs: number;
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
	/** When the latest main-session request went out. */
	lastRequestAt: number;
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
	if (armed.ttlMs !== ONE_HOUR_MS) return "not_one_hour";
	if (probe.now - probe.dueAt > LATE_MS || !probe.warm || probe.now >= armed.at + armed.ttlMs) return "lapsed";
	if (probe.contextTokens < probe.config.minTokens) return "small";
	if (probe.lastRequestAt > armed.at) return "newer_request";
	if (probe.rateLimitStatus !== undefined && probe.rateLimitStatus !== "allowed") return "near_limit";
	if (!probe.idle) return "busy";
	if (probe.lastInteractionAt !== undefined && probe.now - probe.lastInteractionAt < PRESENCE_MS) return "present";
	return null;
}

/** When the timer for a request fires: `fireAtFraction` of its cache lifetime, or the configured delay. */
export function fireAt(armed: Pick<ArmedRequest, "at" | "ttlMs">, config: IdleCompactConfig): number {
	return armed.at + (config.delayMs ?? armed.ttlMs * DEFAULT_FIRE_AT_FRACTION);
}

export interface TimerOps {
	set(cb: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/**
 * One pending timer for the latest one-hour request. Each request replaces the
 * timer (a request that is not one-hour clears it); `cancel()` drops it when
 * the cached prefix stops being the session's (a new session, a compaction, a
 * branch switch, shutdown).
 */
export class IdleCompactTimer {
	private handle: unknown;
	private armed: ArmedRequest | undefined;

	constructor(
		private readonly timer: TimerOps,
		private readonly now: () => number,
		private readonly config: () => IdleCompactConfig,
		private readonly onFire: (armed: ArmedRequest, dueAt: number) => void,
	) {}

	noteRequest(request: ArmedRequest): void {
		this.cancel();
		const config = this.config();
		if (!config.enabled || request.ttlMs !== ONE_HOUR_MS) return;
		this.armed = request;
		const dueAt = fireAt(request, config);
		this.handle = this.timer.set(() => {
			this.handle = undefined;
			this.armed = undefined;
			this.onFire(request, dueAt);
		}, Math.max(0, dueAt - this.now()));
	}

	cancel(): void {
		if (this.handle !== undefined) this.timer.clear(this.handle);
		this.handle = undefined;
		this.armed = undefined;
	}

	get pending(): ArmedRequest | undefined {
		return this.armed;
	}
}
