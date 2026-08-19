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

export type UsageSource = "subagent" | "classifier" | "reader" | "recap" | "setup";

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

/** Minimal shape we need off the extension API — just the event emitter. */
type EventEmitter = { events: { emit(channel: string, data: unknown): void } };

/**
 * Report one non-main LLM call's usage onto the bus. A no-op when the call was
 * unpriced (the footer only sums cost), and never throws into the caller.
 */
export function recordUsage(pi: EventEmitter, source: UsageSource, usage: unknown): void {
	try {
		const cost = costOf(usage);
		if (cost === 0) return;
		pi.events.emit(USAGE_CHANNEL, { source, cost } satisfies UsageRecord);
	} catch {
		// Accounting is best-effort; a broken emit must not fail the tool.
	}
}
