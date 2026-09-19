/**
 * Cross-extension usage bus. pi's built-in footer only sums the MAIN session's
 * entries (assistant messages, tool-result/summary usage) — it never sees the
 * LLM calls our other extensions make out-of-band: in-process subagents run in
 * their own sessions, and the auto-mode classifier and web-fetch reader are
 * one-shot `completeSimple` calls with no session at all. Our footer wants a
 * true all-in cost, so each of those call sites reports its usage here and the
 * footer accumulates it on top of the main-session total.
 *
 * The channel carries a small pre-extracted record rather than a raw pi-ai
 * `Usage`, so no consumer has to know the provider's shape. `recordUsage`
 * swallows its own errors — accounting must never break a tool path.
 */

export const USAGE_CHANNEL = "one-code:usage-recorded";

/**
 * Session entry type each record is persisted under (`pi.appendEntry`), so the
 * all-in cost survives `--continue`/`--session` and a footer that mounts late
 * (the bus is live-only; the entries are the durable ledger the footer sums).
 * Custom entries never enter the LLM context.
 */
export const USAGE_ENTRY_TYPE = "one-code:usage";

export type UsageSource = "subagent" | "classifier" | "reader" | "recap" | "session-title" | "setup";

export interface UsageRecord {
	source: UsageSource;
	/** Dollar cost of the call (pi-ai `Usage.cost.total`), 0 when unpriced. */
	cost: number;
}

/** Safe `cost.total` from an untrusted usage-like object. */
export function costOf(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const cost = (usage as { cost?: { total?: unknown } }).cost;
	const total = cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

/**
 * Minimal shape we need off the extension API: the event emitter, plus the
 * entry appender when the caller has one (unit tests may pass a bare emitter).
 */
type EventEmitter = {
	events: { emit(channel: string, data: unknown): void };
	appendEntry?<T>(customType: string, data?: T): void;
};

/**
 * Report one non-main LLM call's usage: persisted as a session entry (the
 * durable ledger) and announced on the bus (the live repaint signal). A no-op
 * when the call was unpriced (the footer only sums cost), and never throws
 * into the caller.
 */
export function recordUsage(pi: EventEmitter, source: UsageSource, usage: unknown): void {
	try {
		const cost = costOf(usage);
		if (cost === 0) return;
		const record: UsageRecord = { source, cost };
		pi.appendEntry?.(USAGE_ENTRY_TYPE, record);
		pi.events.emit(USAGE_CHANNEL, record);
	} catch {
		// Accounting is best-effort; a broken emit must not fail the tool.
	}
}

/** The persisted cost carried by a session entry, or 0 for any other entry. */
export function usageEntryCost(entry: unknown): number {
	if (!entry || typeof entry !== "object") return 0;
	const e = entry as { type?: string; customType?: string; data?: unknown };
	if (e.type !== "custom" || e.customType !== USAGE_ENTRY_TYPE) return 0;
	const cost = (e.data as { cost?: unknown } | undefined)?.cost;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}
