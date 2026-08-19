/**
 * Pure formatting for the One Code footer — the single status line that
 * replaces pi's built-in footer (`ctx.ui.setFooter`). It surfaces what a user
 * actually watches — context fill, total cost, cache-hit health, the PR, the
 * model, and the effort level — and drops pi's raw ↑/↓/R/W token counters.
 *
 * Everything here is pure and paint-injected so it unit-tests with an identity
 * paint. `paint(color, text)` matches `safeThemePaint`; in tests it returns the
 * text unchanged, so assertions see the plain line. Inclusion decisions use
 * plain lengths only, so the painted result (ANSI adds zero display width)
 * always fits the width it was built for.
 */

import { costOf } from "../lib/usage-bus.ts";

export type Paint = (color: string, text: string) => string;

export interface FooterData {
	/** Absolute cwd; `home` is folded to `~` for display. */
	cwd: string;
	home: string;
	branch?: string;
	/** Context tokens in use and the model's window; both needed to show fill. */
	contextTokens?: number;
	contextWindow?: number;
	/** Context percentage, shown in parens after the fill; `null`/undefined omits it
	 * (e.g. right after compaction, unknown until the next reply). */
	contextPercent?: number | null;
	/** All-in cost across every LLM call this session (main + subagents + one-shots). */
	cost: number;
	/** Latest turn's cache-hit rate; a per-turn health signal, not cumulative. */
	cacheHitPercent?: number;
	/** Open PR number for the current branch, when a `gh` lookup found one. */
	pr?: number;
	/** Short model name (already abbreviated by the caller). */
	model?: string;
	/** Effort label to show after the model — the level, or "✦ ultracode". */
	effort?: string;
}

/** pi's token formatter, replicated so a "1.1M" here reads like pi's own. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Cost with cent-fraction precision for small spends, coarser once it grows. */
export function formatCost(cost: number): string {
	return `$${cost.toFixed(cost < 100 ? 3 : 2)}`;
}

/** Fold the home prefix to `~`. */
function tilde(cwd: string, home: string): string {
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 * Fit a path into `max` columns, keeping the tail (the deepest, most specific
 * folders) with a leading `…`. `max <= 1` collapses to just `…`.
 */
function truncatePath(path: string, max: number): string {
	if (path.length <= max) return path;
	if (max <= 1) return "…";
	return `…${path.slice(path.length - (max - 1))}`;
}

interface Part {
	plain: string;
	painted: string;
	/** Higher drops first when the line is too narrow; 0 = never dropped. */
	dropPriority: number;
}

const SEP = " · ";

/**
 * Build the footer as a single line fit to `width`. When too narrow, the
 * cache-hit rate drops first, then the PR (with the path/branch on the left),
 * then the path itself; context, cost, model, and effort are the core and are
 * kept (truncation is the last resort).
 */
export function buildFooterLines(data: FooterData, width: number, paint: Paint): string[] {
	if (width <= 0) return [""];

	const parts: Part[] = [];
	// A labelled metric: the label is muted, the value takes `color`. The plain
	// form (label + value) drives the width/drop math; the painted form colours
	// the two halves separately.
	const push = (label: string, value: string, color: string, dropPriority = 0) => {
		if (!value) return;
		const plain = label ? `${label} ${value}` : value;
		const painted = label ? `${paint("muted", label)} ${paint(color, value)}` : paint(color, value);
		parts.push({ plain, painted, dropPriority });
	};

	// Context fill as "usage: tokens/window (pct%)".
	if (typeof data.contextTokens === "number" && typeof data.contextWindow === "number" && data.contextWindow > 0) {
		const pct = typeof data.contextPercent === "number" ? ` (${data.contextPercent.toFixed(0)}%)` : "";
		push("usage:", `${formatTokens(data.contextTokens)}/${formatTokens(data.contextWindow)}${pct}`, "dim");
	}
	// Total cost, always shown once known.
	push("cost:", formatCost(data.cost), "dim");
	// Cache-hit: a warning only when it drops low, otherwise dim; droppable.
	if (typeof data.cacheHitPercent === "number") {
		const color = data.cacheHitPercent < 20 ? "error" : data.cacheHitPercent < 50 ? "warning" : "dim";
		push("cache-hit:", `${data.cacheHitPercent.toFixed(0)}%`, color, 2);
	}
	// Model, then effort — no labels; both self-describing.
	if (data.model) push("", data.model, "dim");
	if (data.effort) push("", data.effort, "accent");

	// Left chunk: path + branch, with the open PR attached to the branch as
	// "⎇ branch ← PR #123". The branch (short, useful) is kept and the path is
	// head-truncated to fit; when the PR would not fit, it is dropped before the
	// branch (bare-branch fallback), and only when there is no room even for the
	// bare branch does the whole chunk go, leaving metrics alone. The three
	// segments paint separately — path dim, branch in accent, PR in the link
	// colour — but every width/gap decision uses their plain lengths.
	const path = tilde(data.cwd, data.home);
	const branchSeg = data.branch ? ` ⎇ ${data.branch}` : "";
	const prSeg = data.branch && typeof data.pr === "number" ? ` ← PR #${data.pr}` : "";

	// Drop optional right parts (highest priority first) until the metrics fit.
	let kept = parts.slice();
	const rightPlain = () => kept.map((p) => p.plain).join(SEP);
	while (rightPlain().length > width) {
		const droppable = kept
			.map((p, i) => ({ p, i }))
			.filter((x) => x.p.dropPriority > 0)
			.sort((a, b) => b.p.dropPriority - a.p.dropPriority)[0];
		if (!droppable) break;
		kept = kept.filter((_, i) => i !== droppable.i);
	}

	const rightLen = rightPlain().length;

	// Even the core overflows: last resort, truncate the plain metrics to width.
	if (rightLen > width) {
		return [paint("dim", rightPlain().slice(0, width))];
	}

	const rightPaintedStr = kept.map((p) => p.painted).join(paint("dim", SEP));

	// Room for the left chunk after the metrics and at least one space of gap.
	// Keep the PR only if the branch+PR both fit; otherwise drop it and keep the
	// bare branch.
	const room = width - rightLen - 1;
	const keptPr = room >= branchSeg.length + prSeg.length + 1 ? prSeg : "";
	const suffixLen = branchSeg.length + keptPr.length;
	if (room >= suffixLen + 1) {
		const shownPath = truncatePath(path, room - suffixLen);
		const leftPlain = `${shownPath}${branchSeg}${keptPr}`;
		const gap = " ".repeat(width - leftPlain.length - rightLen);
		const leftPainted = `${paint("dim", shownPath)}${paint("accent", branchSeg)}${paint("mdLink", keptPr)}`;
		return [`${leftPainted}${gap}${rightPaintedStr}`];
	}
	// No room for even the branch: metrics only, right-aligned.
	const pad = " ".repeat(Math.max(0, width - rightLen));
	return [`${pad}${rightPaintedStr}`];
}

/**
 * Main-session cost and latest cache-hit rate, computed from the session
 * entries exactly as pi's own footer does (assistant messages, tool-result and
 * branch-summary/compaction usage). Kept pure and loosely typed so it tests
 * with plain fixtures.
 */
export function computeMainUsage(entries: readonly unknown[]): { cost: number; cacheHitPercent?: number } {
	let cost = 0;
	let cacheHitPercent: number | undefined;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

	for (const raw of entries) {
		const entry = raw as {
			type?: string;
			message?: { role?: string; usage?: Record<string, unknown> };
			usage?: Record<string, unknown>;
		};
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
			const u = entry.message.usage;
			cost += costOf(u);
			// Only meaningful when the provider actually reported cache activity —
			// otherwise leave it unset so the footer omits the field, matching pi
			// (a non-caching provider must not show a permanent "cache-hit: 0%").
			const cacheRead = num(u.cacheRead);
			const hasCacheActivity = cacheRead > 0 || num(u.cacheWrite) > 0;
			const prompt = num(u.input) + cacheRead + num(u.cacheWrite);
			cacheHitPercent = hasCacheActivity && prompt > 0 ? (cacheRead / prompt) * 100 : undefined;
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
			cost += costOf(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			cost += costOf(entry.usage);
		}
	}
	return { cost, cacheHitPercent };
}
