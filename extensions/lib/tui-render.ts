/**
 * Compact tool rendering shared by every One Code tool — the Claude Code look:
 *
 *   ● Label(one-line arg summary)
 *     ⎿  first lines of the result
 *        … +N lines (ctrl+o to expand)
 *
 * instead of pi's default fallback (bold tool name + full JSON args + full
 * output inside a colored box). Pure module — no pi imports; the theme object
 * pi passes to renderers arrives as an argument, and components are the
 * minimal `{ render, invalidate }` shape pi-tui expects (pi-tui itself is not
 * importable from an extension — findings §3).
 *
 * pi-tui crashes the whole app on a rendered line wider than the terminal, so
 * every line goes through `truncateLine` — never skip it.
 */

import { NOTIFICATION_HEADER, NOTIFICATION_PREFIX } from "./notifications.ts";

/** The structural subset of pi-tui's Component that pi's renderers require. */
export interface TuiComponent {
	render(width: number): string[];
	invalidate(): void;
}

/** The structural subset of pi's Theme that this module uses. */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

/**
 * A `paint(color, text)` closure that degrades to the plain text whenever the
 * theme is missing, lacks `fg`, or `fg` throws — the guard every `ctx.ui.custom`
 * renderer needs, since the theme object handed in there is loosely typed.
 */
export function safeThemePaint(theme: unknown): (color: string, text: string) => string {
	return (color: string, text: string) => {
		const themed = theme as { fg?(c: string, t: string): string } | undefined;
		try {
			return themed?.fg ? themed.fg(color, text) : text;
		} catch {
			return text;
		}
	};
}

/** The `inverse(text)` counterpart to safeThemePaint, with the same degrade-to-plain guard. */
export function safeThemeInverse(theme: unknown): (text: string) => string {
	return (text: string) => {
		const themed = theme as { inverse?(t: string): string } | undefined;
		try {
			return themed?.inverse ? themed.inverse(text) : text;
		} catch {
			return text;
		}
	};
}

/** The `bold(text)` counterpart to safeThemePaint, with the same degrade-to-plain guard. */
export function safeThemeBold(theme: unknown): (text: string) => string {
	return (text: string) => {
		const themed = theme as { bold?(t: string): string } | undefined;
		try {
			return themed?.bold ? themed.bold(text) : text;
		} catch {
			return text;
		}
	};
}

/** Humane elapsed time, Claude Code style: 45s, 1m 7s, 2h 5m. */
export function formatDuration(startedAt?: number, finishedAt?: number, now?: number): string {
	if (startedAt === undefined) return "";
	const end = finishedAt ?? now ?? startedAt;
	const total = Math.max(0, Math.round((end - startedAt) / 1000));
	if (total < 60) return `${total}s`;
	if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
	return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/** `2 shells`, `1 shell` — a count with its (s-pluralized) noun. */
export function countNoun(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Right-align plain text within `width` columns. */
export function alignRight(text: string, width: number): string {
	const length = [...text].length;
	if (length >= width) return text.slice(0, Math.max(0, width));
	return " ".repeat(width - length) + text;
}

/**
 * setWidget factory for a one-line, dim, right-aligned note (Claude Code's
 * above-input chrome: the context token counter, the effort-changed note).
 * The one-column right margin matches the paddingX pi gives string widgets.
 */
export function dimRightAlignedWidget(text: string): (tui: unknown, theme: unknown) => TuiComponent {
	return (_tui, theme) => {
		const paint = safeThemePaint(theme);
		return linesComponent((width) => [paint("dim", alignRight(text, Math.max(1, width - 1)))]);
	};
}

/** Strikethrough via raw SGR 9/29 — pi themes have no strike paint. */
export function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}

/**
 * Height for a bounded panel that docks below the transcript (like Claude
 * Code's /plugins and /skills): capped at `max` so the conversation stays
 * visible, at least `min` when the terminal has room — but never taller than
 * the terminal itself, so a short pane (< min+2 rows) shrinks to fit instead of
 * overflowing.
 */
export function boundedDockHeight(terminalRows: number, max: number, min = 12): number {
	const avail = Math.max(1, terminalRows - 2);
	return avail <= min ? avail : Math.min(avail, max);
}

/** Cut plain (unpainted) text to `width` columns by code point, with an ellipsis. */
export function cutPlainText(text: string, width: number): string {
	if (width <= 0) return "";
	const chars = [...text];
	return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…` : text;
}

/** Cut then pad plain (unpainted) text to exactly `width` columns, by code point. */
export function padPlainText(text: string, width: number): string {
	const shortened = cutPlainText(text, width);
	return shortened + " ".repeat(Math.max(0, width - [...shortened].length));
}

/** First non-empty line of a possibly-multiline string, trimmed. */
export function firstNonEmptyLine(text: string): string {
	return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * Full-width rule that separates a docked panel from the transcript above it,
 * the way Claude Code frames its /skills, /plugins and /mcp menus. Paint takes
 * a (color, text) painter; the "border" theme token gives a visible-but-calm line.
 */
export function panelTopRule(paint: (color: string, text: string) => string, width: number): string {
	return paint("border", "─".repeat(Math.max(0, width)));
}

/**
 * A rounded, bordered single-line search input, Claude Code style. Returns three
 * lines (top border, the input row, bottom border), already indented one column.
 * The placeholder shows dim until the user types. `paint` colors the border with
 * the "border" token; the query text stays in the default foreground.
 */
export function searchBoxLines(
	query: string,
	placeholder: string,
	paint: (color: string, text: string) => string,
	width: number,
): string[] {
	const boxWidth = Math.max(12, width - 2); // one column of margin each side
	const inner = boxWidth - 2; // space between the vertical borders
	const label = query ? `⌕ ${query}` : `⌕ ${placeholder}`;
	const cut = cutPlainText(label, inner - 2); // one space padding each side
	const content = ` ${cut}${" ".repeat(Math.max(0, inner - 2 - [...cut].length))} `;
	const v = paint("border", "│");
	return [
		` ${paint("border", `╭${"─".repeat(inner)}╮`)}`,
		` ${v}${query ? content : paint("dim", content)}${v}`,
		` ${paint("border", `╰${"─".repeat(inner)}╯`)}`,
	];
}

/** A run of rendered lines that either can (`selectable`) or cannot host the cursor. */
export interface RenderBlock {
	lines: string[];
	selectable: boolean;
}

/**
 * Window a list of blocks so the block holding the Nth selectable row (`cursor`)
 * stays visible within `budget` lines, returning the visible lines and how many
 * blocks fell off the bottom. Group headers ride along as non-selectable blocks.
 * The cursor's own block is always shown even when it alone exceeds the budget,
 * so a tall selected row never scrolls itself off screen.
 */
export function windowBlocks(blocks: RenderBlock[], cursor: number, budget: number): { lines: string[]; more: number } {
	const selectableIndexes = blocks.map((b, i) => (b.selectable ? i : -1)).filter((i) => i >= 0);
	const cursorBlock = selectableIndexes[cursor] ?? 0;
	const linesBetween = (from: number, to: number) => blocks.slice(from, to + 1).reduce((n, b) => n + b.lines.length, 0);
	let start = 0;
	while (start < cursorBlock && linesBetween(start, cursorBlock) > budget) start++;
	const lines: string[] = [];
	let index = start;
	for (; index < blocks.length; index++) {
		if (lines.length > 0 && lines.length + blocks[index].lines.length > budget) break;
		lines.push(...blocks[index].lines);
	}
	return { lines, more: blocks.length - index };
}

/**
 * Split a row into a left half padded against a right-aligned annotation
 * (two-space gap), fusing into one cut line when the left share would drop
 * below readability. The single home of this layout rule — strip rows, pane
 * rows, and transcript headers all build on it.
 */
export function splitRow(left: string, right: string, width: number): { fused: string } | { left: string; right: string } {
	const leftWidth = width - [...right].length - 2;
	if ([...right].length === 0 || leftWidth < 8) return { fused: cutPlainText(`${left}  ${right}`.trimEnd(), width) };
	return { left: padPlainText(left, leftWidth), right };
}

/** splitRow flattened to one plain string, exactly `width` wide. */
export function splitCell(left: string, right: string, width: number): string {
	const row = splitRow(left, right, width);
	return "fused" in row ? padPlainText(row.fused, width) : `${row.left}  ${row.right}`;
}

/** Hard-wrap plain text to `width` columns by code point, preserving blank lines. */
export function wrapPlainText(text: string, width: number): string[] {
	const columns = Math.max(1, width);
	const out: string[] = [];
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const chars = [...raw];
		if (chars.length === 0) {
			out.push("");
			continue;
		}
		for (let i = 0; i < chars.length; i += columns) {
			out.push(chars.slice(i, i + columns).join(""));
		}
	}
	return out;
}

/**
 * Cut a painted line to `width` visible columns without splitting ANSI escape
 * sequences, ending with an ellipsis and a reset so truncation cannot leak a
 * colour into the next line. pi-tui *crashes* the whole app on an overwide
 * line ("Rendered line exceeds terminal width"), and only validates a
 * component when its output changes — so an overflow can hide in static
 * content for weeks, then kill pi the moment something makes it re-render.
 */
const ANSI_AT = /\x1b\[[0-9;]*m/y;

export function truncateLine(line: string, width: number): string {
	if (width <= 0) return "";
	// Raw length bounds visible width (escapes only ever add), so a line whose
	// raw length fits needs no scan — the hot path for nearly every line.
	if (line.length <= width) return line;
	let visible = 0;
	for (let i = 0; i < line.length; ) {
		ANSI_AT.lastIndex = i;
		const escape = ANSI_AT.exec(line);
		if (escape) {
			i += escape[0].length;
			continue;
		}
		visible++;
		i++;
	}
	if (visible <= width) return line;

	let out = "";
	let used = 0;
	for (let i = 0; i < line.length && used < width - 1; ) {
		ANSI_AT.lastIndex = i;
		const escape = ANSI_AT.exec(line);
		if (escape) {
			out += escape[0];
			i += escape[0].length;
			continue;
		}
		out += line[i];
		used++;
		i++;
	}
	return `${out}\x1b[0m…`;
}

/**
 * Wrap a line-producing function as a component; lines are width-truncated.
 *
 * The result is memoized by width: pi-tui calls every mounted component's
 * `render(width)` on every frame (findings §15), while any state change makes
 * pi re-invoke the renderer factory and mint a fresh component — so within one
 * component's lifetime `build` is pure and the cache can only go stale through
 * `invalidate()` (theme swap), which clears it.
 */
export function linesComponent(build: (width: number) => string[]): TuiComponent {
	const cache = new Map<number, string[]>();
	return {
		render(width: number): string[] {
			const hit = cache.get(width);
			if (hit) return hit;
			const lines = build(width).map((line) => truncateLine(line, width));
			if (cache.size >= 4) cache.clear(); // resizes produce a few widths, never many
			cache.set(width, lines);
			return lines;
		},
		invalidate() {
			cache.clear();
		},
	};
}

/**
 * A single dim transcript line led by a dim mark ("✻ Cooked for 5m 12s",
 * "※ recap: …") — the shared shape behind the turn-duration and recap
 * display-only entries. Width-memoized via linesComponent.
 */
export function dimMarkedLine(theme: unknown, mark: string, text: string): TuiComponent {
	const paint = safeThemePaint(theme);
	return linesComponent(() => [`${paint("dim", mark)} ${paint("dim", text)}`]);
}

/**
 * Params commonly carrying the human-meaningful part of a tool call, in
 * priority order. Used when a tool does not supply its own `title`.
 */
const PRIMARY_ARG_KEYS = [
	"command",
	"query",
	"url",
	"path",
	"file_path",
	"skill",
	"pattern",
	"task_id",
	"taskId",
	"id",
	"agent",
	"name",
	"action",
	"subject",
	"description",
	"prompt",
	"task",
] as const;

/** Collapse whitespace/newlines so a summary always fits on one line. */
function oneLine(text: string, max = 96): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One-line summary of a tool's arguments for the call line. Picks the first
 * well-known primary key present, else the first string value; returns "" for
 * empty/absent args (streaming tool calls render before args are complete).
 */
export function summarizeArgs(args: unknown): string {
	if (typeof args === "string") return oneLine(args);
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of PRIMARY_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return oneLine(value);
		if (typeof value === "number") return String(value);
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return oneLine(value);
	}
	return "";
}

export const EXPAND_HINT = "ctrl+o to expand";

/** Split result text into shown lines + hidden count for the collapsed view. */
export function collapseLines(
	text: string,
	expanded: boolean,
	maxCollapsed = 5,
): { lines: string[]; hidden: number } {
	const lines = text.replace(/\s+$/, "").split("\n");
	if (expanded || lines.length <= maxCollapsed) return { lines, hidden: 0 };
	return { lines: lines.slice(0, maxCollapsed), hidden: lines.length - maxCollapsed };
}

/** Status → bullet color for the call line. */
export function bulletColor(isPartial: boolean, isError: boolean): string {
	if (isPartial) return "muted";
	return isError ? "error" : "success";
}

/**
 * Theme tokens the running-call bullet breathes through, giving the ● a pulse
 * while the tool is in flight: a clay flash rises out of the greys once per
 * cycle, reading as a heartbeat. Ends on the static success/error bullet.
 */
export const SPINNER_COLORS = ["dim", "muted", "accent", "muted"] as const;
/** Bullet pulse tick; ~1.2s per full breath (4 frames), a calm heartbeat well clear of pi's 80ms spinner. */
export const SPINNER_INTERVAL_MS = 300;

/** Persistent per-tool-row spinner state, stored on `context.state`. */
interface SpinnerState {
	frame: number;
	timer: ReturnType<typeof setInterval> | undefined;
}

/** The subset of a tool render context the bullet pulse needs. */
export interface SpinnerContext {
	isPartial: boolean;
	/** Wired to `ui.requestRender()` in the live TUI; absent in unit stubs. */
	invalidate?: () => void;
	/** Persistent per-row store; absent in unit stubs. */
	state?: { ccSpinner?: SpinnerState };
}

/**
 * Bullet colour for the call line, driving the running-call pulse. pi re-invokes
 * `renderCall` on every `invalidate()` with a fresh context, and `context.state`
 * is the same object across a tool row's lifetime — so the frame counter and the
 * interval handle live there. While `isPartial`, a lone interval advances the
 * frame and calls `context.invalidate()` to repaint; it self-terminates the moment
 * `isPartial` flips false, because `renderCall` components get no dispose hook
 * (findings §3). Returns `undefined` when idle so `callLine` uses its static
 * success/error bullet. Call once per `renderCall`, not per `render(width)`.
 */
export function spinnerBulletColor(context: SpinnerContext): string | undefined {
	// No persistent state (or no way to repaint) → no animation; fall back to the
	// static bullet. tool-execution.ts always supplies both in the live TUI.
	const state = context.state;
	const invalidate = context.invalidate;
	if (!state || typeof invalidate !== "function") return undefined;
	if (!context.isPartial) {
		if (state.ccSpinner?.timer) {
			clearInterval(state.ccSpinner.timer);
			state.ccSpinner.timer = undefined;
		}
		return undefined;
	}
	const spinner = (state.ccSpinner ??= { frame: 0, timer: undefined });
	if (!spinner.timer) {
		spinner.timer = setInterval(() => {
			spinner.frame = (spinner.frame + 1) % SPINNER_COLORS.length;
			invalidate();
		}, SPINNER_INTERVAL_MS);
	}
	return SPINNER_COLORS[spinner.frame];
}

/**
 * `● Label(summary)` — the call line. `bulletColorOverride` (from
 * `spinnerBulletColor`) paints the running-call pulse; omit it for the static
 * status colour.
 */
export function callLine(
	theme: ThemeLike,
	label: string,
	summary: string,
	isPartial: boolean,
	isError: boolean,
	bulletColorOverride?: string,
): string {
	const bullet = theme.fg(bulletColorOverride ?? bulletColor(isPartial, isError), "●");
	const name = theme.bold(label);
	return summary ? `${bullet} ${name}(${theme.fg("muted", summary)})` : `${bullet} ${name}`;
}

/**
 * `  ⎿  line…` — the result lines. First line carries the elbow, the rest are
 * aligned under it; a `… +N lines` trailer advertises ctrl+o when collapsed.
 */
export function resultLines(theme: ThemeLike, text: string, expanded: boolean, isError: boolean, maxCollapsed = 5): string[] {
	const { lines, hidden } = collapseLines(text, expanded, maxCollapsed);
	const color = isError ? "error" : "muted";
	const out = lines.map((line, i) => (i === 0 ? `  ⎿  ${theme.fg(color, line)}` : `     ${theme.fg(color, line)}`));
	if (hidden > 0) out.push(`     ${theme.fg("dim", `… +${hidden} lines (${EXPAND_HINT})`)}`);
	return out;
}

/** Join a tool result's text blocks into one string. */
export function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	if (!result?.content) return "";
	return result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
		.trim();
}

export interface CcRenderSpec<TArgs = unknown, TDetails = unknown> {
	/** One-line arg summary shown in parentheses. Default: `summarizeArgs`. */
	title?: (args: TArgs | undefined) => string | undefined;
	/**
	 * Result text to display (still collapsed/expanded by the shared logic).
	 * Default: the result's text content. Return "" to hide the result block.
	 */
	result?: (
		result: { content: Array<{ type: string; text?: string }>; details?: TDetails },
		args: TArgs | undefined,
		isError: boolean,
	) => string | undefined;
	/** Lines shown before the `… +N lines` trailer kicks in. Default 5. */
	maxCollapsedLines?: number;
}

/**
 * renderShell/renderCall/renderResult for `pi.registerTool` — spread into the
 * definition: `...ccToolRenderers("Task Output", { title: (a) => a?.task_id })`.
 *
 * Renderers must never throw (pi silently swaps in its verbose fallback), so
 * everything user-supplied is guarded.
 */
export function ccToolRenderers<TArgs = any, TDetails = any>(
	label: string,
	spec: CcRenderSpec<TArgs, TDetails> = {},
): {
	renderShell: "self";
	renderCall: (args: TArgs, theme: any, context: any) => TuiComponent;
	renderResult: (result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) => TuiComponent;
} {
	const titleOf = (args: TArgs | undefined): string => {
		try {
			const custom = spec.title?.(args);
			if (custom !== undefined) return oneLine(custom);
		} catch {
			// fall through to the generic summary
		}
		return summarizeArgs(args);
	};

	return {
		renderShell: "self",
		renderCall(args: TArgs, theme: ThemeLike, context: { isPartial: boolean; isError: boolean } & SpinnerContext) {
			const bulletOverride = spinnerBulletColor(context);
			return linesComponent(() => [callLine(theme, label, titleOf(args), context.isPartial, context.isError, bulletOverride)]);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: TDetails },
			options: { expanded: boolean; isPartial: boolean },
			theme: ThemeLike,
			context: { args?: TArgs; isError: boolean },
		) {
			let text: string | undefined;
			try {
				text = spec.result?.(result, context.args, context.isError);
			} catch {
				text = undefined;
			}
			text ??= textContent(result);
			if (!text) return linesComponent(() => []);
			return linesComponent(() => resultLines(theme, text, options.expanded, context.isError, spec.maxCollapsedLines));
		},
	};
}

/**
 * Strip the `systemNotification` anti-confabulation framing for display: the
 * framing exists for the model, not the user (findings §14). Returns the body.
 */
export function notificationBody(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.startsWith(NOTIFICATION_HEADER)) {
		let i = 1;
		while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith(NOTIFICATION_PREFIX))) i++;
		return lines.slice(i).join("\n").trim();
	}
	return text.trim();
}

/** True when a line is visually empty — ANSI codes (Box padding paints) don't count as content. */
export function isBlankLine(line: string): boolean {
	return line.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
}

/** Indent a component's lines under a `⎿` elbow, CC-style. */
export function elbowIndent(lines: string[]): string[] {
	const trimmed = [...lines];
	while (trimmed.length > 0 && isBlankLine(trimmed[0])) trimmed.shift();
	return trimmed.map((line, i) => (i === 0 ? `  ⎿  ${line}` : `     ${line}`));
}

export interface CcWrapOptions<TArgs = any> {
	/** One-line arg summary for the call line. Default: `summarizeArgs`. */
	title?: (args: TArgs | undefined) => string | undefined;
	/**
	 * Keep the base call component and only replace its first (header) line
	 * with the `●` call line — for tools whose call component carries real
	 * content below the header (edit's diff preview, shown before approval).
	 */
	keepBaseCall?: boolean;
}

/**
 * Wrap a pi built-in tool's renderers in the `●`/`⎿` language while keeping
 * the base result component — its streaming, truncation, and ctrl+o expansion
 * behavior is upstream's and better than a reimplementation. Inner components
 * are stored on `context.state` rather than returned as `lastComponent`,
 * because base renderers cast `lastComponent` to their own concrete classes
 * and would throw on our wrapper.
 */
export function ccWrapBuiltinRenderers<TArgs = any>(
	label: string,
	base: {
		renderCall?: (args: any, theme: any, context: any) => any;
		renderResult?: (result: any, options: any, theme: any, context: any) => any;
	},
	opts: CcWrapOptions<TArgs> = {},
): {
	renderShell: "self";
	renderCall: (args: TArgs, theme: any, context: any) => TuiComponent;
	renderResult: (result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) => TuiComponent;
} {
	const titleOf = (args: TArgs | undefined): string => {
		try {
			const custom = opts.title?.(args);
			if (custom !== undefined) return summarizeArgs(custom);
		} catch {
			// fall through to the generic summary
		}
		return summarizeArgs(args);
	};

	return {
		renderShell: "self",
		renderCall(args: TArgs, theme: ThemeLike, context: any) {
			const bulletOverride = spinnerBulletColor(context);
			const head = () => callLine(theme, label, titleOf(args), context.isPartial, context.isError, bulletOverride);
			if (!opts.keepBaseCall || !base.renderCall) {
				return linesComponent(() => [head()]);
			}
			let inner: any;
			try {
				inner = base.renderCall(args, theme, { ...context, lastComponent: context.state.ccInnerCall });
				context.state.ccInnerCall = inner;
			} catch {
				return linesComponent(() => [head()]);
			}
			// Memoized by width for settled calls (same contract as linesComponent);
			// a partial call streams through its base component, so it stays live.
			const cache = new Map<number, string[]>();
			return {
				render(width: number): string[] {
					const hit = !context.isPartial && cache.get(width);
					if (hit) return hit;
					// The base component is a padded Box: skip its blank padding
					// (painted lines — ANSI-aware test), then its header line —
					// ours replaces it.
					const lines: string[] = [...(inner.render(width) ?? [])];
					while (lines.length > 0 && isBlankLine(lines[0])) lines.shift();
					lines.shift();
					const out = [head(), ...lines].map((line) => truncateLine(line, width));
					if (cache.size >= 4) cache.clear();
					cache.set(width, out);
					return out;
				},
				invalidate() {
					cache.clear();
					inner.invalidate?.();
				},
			};
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: any) {
			let inner: any;
			try {
				inner = base.renderResult?.(result, options, theme, { ...context, lastComponent: context.state.ccInnerResult });
				context.state.ccInnerResult = inner;
			} catch {
				inner = undefined;
			}
			if (!inner) {
				const text = textContent(result);
				if (!text) return linesComponent(() => []);
				return linesComponent(() => resultLines(theme, text, options.expanded, context.isError));
			}
			// Same memoization as the call wrapper: settled results are static.
			const cache = new Map<number, string[]>();
			return {
				render(width: number): string[] {
					const hit = !options.isPartial && cache.get(width);
					if (hit) return hit;
					const innerLines: string[] = inner.render(Math.max(10, width - 5)) ?? [];
					const out = innerLines.every((line) => line.trim() === "")
						? []
						: elbowIndent(innerLines).map((line) => truncateLine(line, width));
					if (cache.size >= 4) cache.clear();
					cache.set(width, out);
					return out;
				},
				invalidate() {
					cache.clear();
					inner.invalidate?.();
				},
			};
		},
	};
}

/** Text of a CustomMessage's content (string or text-block array). */
export function customMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (block && typeof block === "object" && (block as any).type === "text" ? ((block as any).text ?? "") : ""))
			.join("\n");
	}
	return String(content ?? "");
}

/**
 * Compact transcript rendering for harness-injected messages (background
 * completions, subagent replies, monitor batches, wakeups): one dim headline
 * collapsed, the full body on ctrl+o.
 */
export function notificationComponent(theme: ThemeLike, text: string, expanded: boolean): TuiComponent {
	const body = notificationBody(text);
	const lines = body.split("\n");
	const headline = oneLine(lines[0] ?? "");
	// pi's custom-message shell already prepends a spacer — emit content only.
	return linesComponent(() => {
		if (!expanded) {
			const more = lines.length > 1 ? theme.fg("dim", ` (+${lines.length - 1} lines, ${EXPAND_HINT})`) : "";
			return [`${theme.fg("dim", "✳")} ${theme.fg("muted", theme.italic(headline))}${more}`];
		}
		return [`${theme.fg("dim", "✳")} ${theme.fg("muted", theme.italic(headline))}`, ...lines.slice(1).map((l) => `  ${theme.fg("muted", l)}`)];
	});
}
