/**
 * Token/cost accounting for child-process subagent runs.
 *
 * A child run in `--mode json` emits one `message_end` per assistant message,
 * each carrying a pi-ai `Usage` for that API call; summing them gives the
 * run's totals (the in-process equivalent is `session.getSessionStats()`).
 */

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

/** Field-wise sum of two totals (pure — neither input is mutated). */
export function sumUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		total: a.total + b.total,
		cost: a.cost + b.cost,
	};
}

/** Add one assistant message's `usage` (untrusted JSONL) into `totals`. */
export function addUsage(totals: UsageTotals, usage: unknown): void {
	if (!usage || typeof usage !== "object") return;
	const u = usage as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	totals.input += num(u.input);
	totals.output += num(u.output);
	totals.cacheRead += num(u.cacheRead);
	totals.cacheWrite += num(u.cacheWrite);
	totals.total += num(u.totalTokens);
	const cost = u.cost as Record<string, unknown> | undefined;
	totals.cost += num(cost?.total);
}

export function formatTokenCount(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

/** Compact stats suffix, e.g. "45.3k tokens · $0.0421". Empty when nothing was recorded. */
export function formatUsage(totals: UsageTotals): string {
	if (totals.total <= 0) return "";
	const parts = [`${formatTokenCount(totals.total)} tokens`];
	if (totals.cost > 0) parts.push(`$${totals.cost.toFixed(4)}`);
	return parts.join(" · ");
}

/** A run's "N tools · <usage>" line; the usage suffix is dropped when empty. */
export function formatStats(toolCalls: number, totals: UsageTotals): string {
	return [`${toolCalls} tools`, formatUsage(totals)].filter(Boolean).join(" · ");
}
