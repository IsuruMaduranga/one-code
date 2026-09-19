/**
 * Pure state, key decoding, and rendering for the `/btw` answer overlay — Claude
 * Code's side-question panel: a focused, scrollable view of the answer with the
 * question dim above it. `↑/↓` (and PgUp/PgDn) scroll, `c` copies the answer,
 * `Esc` closes.
 *
 * Kept free of pi imports so the scroll maths and layout are unit-tested; the
 * extension owns the overlay, repaint, and the actual clipboard write. CC's
 * panel also offers `f to fork`; One Code omits it (pi exposes no primitive to
 * branch a session with an injected exchange) — docs/decisions/btw.md.
 */

import { panelTopRule, safeThemePaint, truncateLine, wrapPlainText } from "../lib/tui-render.ts";

export const BTW_MAX_HEIGHT = 24;

/** Key hint shown at the foot of the panel. Every key here is discoverable. */
export const BTW_HINT = "↑/↓ to scroll · c to copy · Esc to close";

/** Most echoed question lines shown in the header, so it can't starve the body. */
export const MAX_QUESTION_LINES = 4;

/**
 * The panel's body state. The pure module owns the text for each phase so every
 * appearance (loading, error, answer) is rendered — and tested — here rather
 * than assembled by the extension wiring.
 */
export type BtwBody = { kind: "loading" } | { kind: "error"; message: string } | { kind: "answer"; text: string };

/** The text shown in the body for a given phase. */
function bodyText(body: BtwBody): string {
	switch (body.kind) {
		case "loading":
			return "Thinking…";
		case "error":
			return `Side question failed: ${body.message}`;
		case "answer":
			return body.text || "(no answer)";
	}
}

export interface BtwPanelState {
	/** First body line shown (0 = top). */
	offset: number;
	/** Largest valid offset for the current viewport; render keeps it current. */
	maxOffset: number;
	/** Visible body lines in the current viewport; render keeps it current. */
	viewport: number;
	/** Set for one frame after a copy so the footer can confirm it. */
	copied: boolean;
}

export function initialBtwState(): BtwPanelState {
	return { offset: 0, maxOffset: 0, viewport: 1, copied: false };
}

export type BtwKey = { kind: "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "copy" | "close" };

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
		case "c":
		case "C":
			return { kind: "copy" };
		case "\x1b":
		case "\x03": // ctrl+c
		case "q":
			return { kind: "close" };
		default:
			return undefined;
	}
}

export type BtwEffect = { kind: "copy" } | { kind: "close" };

/** Page size for PgUp/PgDn: nearly a full viewport, one line of overlap for orientation. */
function pageStep(viewport: number): number {
	return Math.max(1, viewport - 1);
}

/**
 * Apply a key to the scroll state. Returns an effect for the extension to run
 * (copy, close) or undefined for a scroll (repaint only). Offsets are clamped to
 * `state.maxOffset`, and pages by `state.viewport` — both set by the most recent
 * render from the real viewport.
 */
export function applyBtwKey(state: BtwPanelState, key: BtwKey): BtwEffect | undefined {
	state.copied = false;
	const step = pageStep(state.viewport);
	switch (key.kind) {
		case "up":
			state.offset = Math.max(0, state.offset - 1);
			return undefined;
		case "down":
			state.offset = Math.min(state.maxOffset, state.offset + 1);
			return undefined;
		case "pageUp":
			state.offset = Math.max(0, state.offset - step);
			return undefined;
		case "pageDown":
			state.offset = Math.min(state.maxOffset, state.offset + step);
			return undefined;
		case "top":
			state.offset = 0;
			return undefined;
		case "bottom":
			state.offset = state.maxOffset;
			return undefined;
		case "copy":
			return { kind: "copy" };
		case "close":
			return { kind: "close" };
	}
}

/**
 * Render the panel to at most `height` lines. The header (the dim question) and
 * footer (rule + key hint, with a scroll indicator and a copy confirmation) are
 * fixed; the answer scrolls within what remains. Clamps and writes back
 * `state.offset`/`state.maxOffset` so key handling scrolls against the real
 * body length. Every line is width-truncated (pi-tui crashes on an overwide
 * line).
 */
export function renderBtwPanel(
	input: { state: BtwPanelState; question: string; body: BtwBody; width: number; height: number },
	theme?: unknown,
): string[] {
	const { state, question, body, width, height } = input;
	const paint = safeThemePaint(theme);
	const inner = Math.max(1, width);

	// Cap the echoed question so a long one (a pasted paragraph or URL) cannot
	// grow the header past the panel height and starve the answer of rows; a
	// truncated last line gets an ellipsis. The answer is what scrolls, not the
	// question.
	const questionLines = wrapPlainText(question.trim(), inner);
	const shownQuestion =
		questionLines.length > MAX_QUESTION_LINES
			? [...questionLines.slice(0, MAX_QUESTION_LINES - 1), truncateLine(`${questionLines[MAX_QUESTION_LINES - 1]}…`, inner)]
			: questionLines;
	const header = [
		paint("accent", truncateLine("Side question", inner)),
		...shownQuestion.map((line) => paint("muted", truncateLine(line, inner))),
		panelTopRule(paint, inner),
	];

	const bodyAll = wrapPlainText(bodyText(body), inner);
	const capacity = Math.max(1, height - header.length - 2); // 2 = footer rule + hint
	state.viewport = capacity;
	state.maxOffset = Math.max(0, bodyAll.length - capacity);
	state.offset = Math.min(Math.max(0, state.offset), state.maxOffset);

	const visible = bodyAll.slice(state.offset, state.offset + capacity).map((line) => truncateLine(line, inner));
	// Pad a short answer so the footer sits at the panel's foot, not mid-screen.
	while (visible.length < capacity) visible.push("");

	const scrollNote = state.maxOffset > 0 ? `  (${state.offset + 1}-${Math.min(state.offset + capacity, bodyAll.length)} of ${bodyAll.length})` : "";
	const hint = state.copied ? "Copied to clipboard" : `${BTW_HINT}${scrollNote}`;
	const footer = [panelTopRule(paint, inner), paint("muted", truncateLine(hint, inner))];

	return [...header, ...visible, ...footer];
}
