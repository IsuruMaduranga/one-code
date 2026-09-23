/**
 * Pure state, key decoding, and rendering for the `/btw` panel, laid out as
 * Claude Code's: the session's earlier side questions (the last five, with a
 * count of older ones), the current question marked `/btw`, the answer
 * indented under them, and a hint line naming only the keys that apply.
 *
 * Shift+←/→, `[`/`]` and Tab/Shift+Tab browse the earlier answers, ↑/↓ scroll
 * (PgUp/PgDn and Home/End too), `c` copies the answer on screen, `f` forks the
 * current answer into a background subagent, `x` clears the history, and Esc,
 * Enter, Space or `q` close.
 *
 * Kept free of pi imports so the browse and scroll maths and the layout are
 * unit-tested; the extension owns the overlay, the model call, the clipboard
 * write and the fork request.
 */

import type { BtwExchange } from "./prompt.ts";
import { panelTopRule, safeThemeBold, safeThemePaint, truncateLine, wrapPlainText } from "../lib/tui-render.ts";

export const BTW_MAX_HEIGHT = 24;

/** Earlier questions listed (and browsable) above the current one. */
export const SHOWN_HISTORY = 5;

/** Lines one ↑/↓ press scrolls. */
const SCROLL_STEP = 3;

/** Columns the answer is indented by, under the question list. */
const ANSWER_INDENT = 4;

/** Columns the question list is indented by. */
const LIST_INDENT = 2;

/** The current question's body: its answer, a failure, or still waiting. */
export type BtwBody = { kind: "loading" } | { kind: "error"; message: string } | { kind: "answer"; text: string };

export interface BtwPanelState {
	/** First answer line shown (0 = top). */
	offset: number;
	/** Largest valid offset for the current viewport; render keeps it current. */
	maxOffset: number;
	/** Visible answer lines in the current viewport; render keeps it current. */
	viewport: number;
	/** Set for one frame after a copy so the hint can confirm it. */
	copied: boolean;
	/** The earlier exchange on screen (an index into the history), or null for the current question. */
	selected: number | null;
}

export function initialBtwState(): BtwPanelState {
	return { offset: 0, maxOffset: 0, viewport: 1, copied: false, selected: null };
}

export type BtwKey =
	| { kind: "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "copy" | "fork" | "clear" | "close" }
	| { kind: "browse"; direction: "older" | "newer"; wrap: boolean };

export function decodeBtwKey(data: string): BtwKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
		case "\x10": // ctrl+p
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
		case "\x0e": // ctrl+n
			return { kind: "down" };
		case "\x1b[5~":
			return { kind: "pageUp" };
		case "\x1b[6~":
			return { kind: "pageDown" };
		case "\x1b[H":
		case "\x1bOH":
			return { kind: "top" };
		case "\x1b[F":
		case "\x1bOF":
			return { kind: "bottom" };
		case "\x1b[1;2D": // shift+left
		case "[":
			return { kind: "browse", direction: "older", wrap: false };
		case "\x1b[1;2C": // shift+right
		case "]":
			return { kind: "browse", direction: "newer", wrap: false };
		case "\t":
			return { kind: "browse", direction: "older", wrap: true };
		case "\x1b[Z": // shift+tab
			return { kind: "browse", direction: "newer", wrap: true };
		case "c":
		case "C":
			return { kind: "copy" };
		case "f":
		case "F":
			return { kind: "fork" };
		case "x":
		case "X":
			return { kind: "clear" };
		case "\x1b":
		case "\x03": // ctrl+c
		case "\x04": // ctrl+d
		case "\r":
		case " ":
		case "q":
			return { kind: "close" };
		default:
			return undefined;
	}
}

export type BtwEffect = { kind: "copy" } | { kind: "fork" } | { kind: "clear" } | { kind: "close" };

/** Page size for PgUp/PgDn: nearly a full viewport, one line of overlap for orientation. */
function pageStep(viewport: number): number {
	return Math.max(1, viewport - 1);
}

/**
 * Move the selection one step through the current question and the last
 * SHOWN_HISTORY earlier ones (Claude Code's order: older goes up the list).
 * Without `wrap` it stops at either end; with it, it cycles.
 */
function browse(state: BtwPanelState, historyLength: number, direction: "older" | "newer", wrap: boolean): void {
	const reachable = Math.min(historyLength, SHOWN_HISTORY);
	const distance = state.selected === null ? 0 : historyLength - state.selected;
	const step = direction === "older" ? 1 : -1;
	const next = wrap ? (distance + step + reachable + 1) % (reachable + 1) : Math.min(Math.max(distance + step, 0), reachable);
	if (next === distance) return;
	state.selected = next === 0 ? null : historyLength - next;
	state.offset = 0;
}

/**
 * Apply a key. Returns an effect for the extension to run (copy, fork, clear,
 * close) or undefined for a scroll or browse (repaint only). Offsets clamp to
 * `state.maxOffset` and page by `state.viewport`, both set by the last render.
 */
export function applyBtwKey(state: BtwPanelState, key: BtwKey, historyLength: number): BtwEffect | undefined {
	state.copied = false;
	switch (key.kind) {
		case "up":
			state.offset = Math.max(0, state.offset - SCROLL_STEP);
			return undefined;
		case "down":
			state.offset = Math.min(state.maxOffset, state.offset + SCROLL_STEP);
			return undefined;
		case "pageUp":
			state.offset = Math.max(0, state.offset - pageStep(state.viewport));
			return undefined;
		case "pageDown":
			state.offset = Math.min(state.maxOffset, state.offset + pageStep(state.viewport));
			return undefined;
		case "top":
			state.offset = 0;
			return undefined;
		case "bottom":
			state.offset = state.maxOffset;
			return undefined;
		case "browse":
			browse(state, historyLength, key.direction, key.wrap);
			return undefined;
		case "copy":
		case "fork":
		case "clear":
		case "close":
			return { kind: key.kind };
	}
}

/**
 * Renders an answer to lines at a width: plain wrapping by default, Markdown in
 * the extension. `ref` is stable for one answer (its exchange, or the panel
 * state for the current one), so a renderer can cache by it.
 */
export type AnswerRenderer = (text: string, width: number, ref: object) => string[];

export interface BtwPanelInput {
	state: BtwPanelState;
	/** The session's earlier exchanges, oldest first. */
	history: readonly BtwExchange[];
	question: string;
	body: BtwBody;
	width: number;
	height: number;
	/** The current answer can be forked (the extension knows whether a fork can start). */
	canFork?: boolean;
	/** A fork request is in flight. */
	forking?: boolean;
	renderAnswer?: AnswerRenderer;
}

/** One question on one line, whitespace collapsed, cut to fit (Claude Code's list row). */
function questionLine(question: string, width: number): string {
	return truncateLine(question.replace(/\s+/g, " ").trim(), Math.max(20, width - 7));
}

/**
 * Render the panel to at most `height` lines. The answer scrolls within what
 * the question list and hint leave; `state.offset`, `maxOffset` and `viewport`
 * are written back so key handling scrolls against the real answer length.
 * Every line is width-truncated (pi-tui crashes on an overwide line).
 */
export function renderBtwPanel(input: BtwPanelInput, theme?: unknown): string[] {
	const { state, history, question, body, width, height } = input;
	const paint = safeThemePaint(theme);
	const bold = safeThemeBold(theme);
	const inner = Math.max(1, width);
	const pad = " ".repeat(LIST_INDENT);
	if (state.selected !== null && (state.selected < 0 || state.selected >= history.length)) state.selected = null;
	const selected = state.selected === null ? undefined : history[state.selected];

	// On a short dock, list fewer earlier questions rather than overflow it: the
	// rule, blanks, current question, one answer row and the hint always fit.
	const listRows = Math.max(0, height - 7);
	let shownCount = Math.min(SHOWN_HISTORY, history.length);
	while (shownCount > 0 && shownCount + (history.length > shownCount ? 1 : 0) > listRows) shownCount--;
	const shown = history.slice(history.length - shownCount);
	const hidden = history.length - shown.length;
	const list: string[] = [];
	if (hidden > 0 && shownCount < listRows) list.push(paint("muted", `${pad}(+${hidden} earlier /btw)`));
	shown.forEach((exchange, i) => {
		const text = `${pad}/btw ${questionLine(exchange.question, inner)}`;
		list.push(state.selected === hidden + i ? bold(text) : paint("muted", text));
	});
	const marker = selected ? paint("muted", "/btw ") : bold(paint("warning", "/btw "));
	list.push(`${pad}${marker}${paint("muted", questionLine(question, inner))}`);

	const answerWidth = Math.max(1, inner - ANSWER_INDENT);
	const renderAnswer = input.renderAnswer ?? wrapPlainText;
	const answerLines = selected
		? renderAnswer(selected.answer, answerWidth, selected)
		: body.kind === "answer"
			? renderAnswer(body.text || "(no answer)", answerWidth, state)
			: body.kind === "error"
				? wrapPlainText(body.message, answerWidth).map((line) => paint("error", line))
				: [paint("muted", "Answering…")];

	const header = [panelTopRule(paint, inner), "", ...list, ""];
	const footerRows = 2; // blank + hint
	const capacity = Math.max(1, height - header.length - footerRows);
	state.viewport = capacity;
	state.maxOffset = Math.max(0, answerLines.length - capacity);
	state.offset = Math.min(Math.max(0, state.offset), state.maxOffset);
	const indent = " ".repeat(ANSWER_INDENT);
	const visible = answerLines.slice(state.offset, state.offset + capacity).map((line) => `${indent}${line}`);

	const currentAnswer = body.kind === "answer" && body.text !== "";
	const hasAnswer = Boolean(selected) || currentAnswer;
	let hint: string;
	if (input.forking) {
		hint = paint("muted", "Forking…");
	} else {
		const parts: string[] = [];
		if (history.length > 0) parts.push(paint("muted", "⇧←/→ to browse"));
		else if (body.kind !== "loading") parts.push(paint("muted", "↑/↓ to scroll"));
		if (hasAnswer) parts.push(state.copied ? paint("success", "Copied to clipboard") : paint("muted", "c to copy"));
		if (input.canFork && !selected && currentAnswer) parts.push(paint("muted", "f to fork"));
		if (history.length > 0) parts.push(paint("muted", "x to clear history"));
		parts.push(paint("muted", "Esc to close"));
		hint = parts.join(paint("muted", " · "));
	}

	return [...header, ...visible, "", `${pad}${hint}`].map((line) => truncateLine(line, inner));
}
