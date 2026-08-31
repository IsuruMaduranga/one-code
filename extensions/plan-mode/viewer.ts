/**
 * Plan-approval viewer (pure): key decoding, wrapping, and rendering for the
 * scrollable dialog exit_plan_mode shows. The thin ctx.ui.custom component in
 * index.ts owns nothing but mutable state and repaint calls — same split as
 * auto-mode's model picker.
 *
 * Every rendered line must stay within the width given: pi-tui crashes the
 * whole app on an overwide line. Content is wrapped (not truncated — a plan
 * must stay readable in full), and chrome lines are cut plain-text *before*
 * painting so ANSI escapes never confuse the width accounting.
 */

import { cutPlainText } from "../lib/tui-render.ts";

/** Hard-wrap plain text to `width` columns, preserving blank lines. */
export { wrapPlainText as wrapPlanText } from "../lib/tui-render.ts";

/** What the dialog resolves to; index into the choices list, or null for cancel. */
export type PlanChoice = number;

export type ViewerKey =
	| { kind: "scroll"; delta: number }
	| { kind: "choice"; delta: number }
	| { kind: "pick"; index: PlanChoice }
	| { kind: "confirm" }
	| { kind: "cancel" };

/**
 * Decode a raw terminal chunk; `page` is the scroll step for PgUp/PgDn. Digit
 * keys resolve to a raw 0-based `pick` index; the caller clamps it to the number
 * of choices actually shown (the list is dynamic — auto mode joins only when a
 * classifier model is reachable).
 */
export function decodeViewerKey(data: string, page: number): ViewerKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
			return { kind: "scroll", delta: -1 };
		case "\x1b[B":
		case "\x1bOB":
			return { kind: "scroll", delta: 1 };
		case "\x1b[5~":
			return { kind: "scroll", delta: -page };
		case "\x1b[6~":
			return { kind: "scroll", delta: page };
		case "\x1b[D":
		case "\x1bOD":
			return { kind: "choice", delta: -1 };
		case "\x1b[C":
		case "\x1bOC":
		case "\t":
			return { kind: "choice", delta: 1 };
		case "\r":
		case "\n":
			return { kind: "confirm" };
		case "\x1b":
		case "\x03": // ctrl+c — same intent as escape while the dialog is focused
			return { kind: "cancel" };
		default:
			if (data.length === 1 && data >= "1" && data <= "9") {
				return { kind: "pick", index: Number(data) - 1 };
			}
			return undefined;
	}
}

export function clampOffset(offset: number, total: number, visible: number): number {
	return Math.max(0, Math.min(offset, Math.max(0, total - visible)));
}

/**
 * The initially highlighted choice: the safest approving option ("manual
 * approvals", mode "default"). Auto mode may lead the list so it is one
 * keypress away, but Enter without arrowing must keep approving into manual
 * mode — the pre-auto-option behavior — never silently switch the session
 * into a more permissive mode.
 */
export function initialPlanChoice(options: readonly { mode?: string }[]): PlanChoice {
	const index = options.findIndex((o) => o.mode === "default");
	return index >= 0 ? index : 0;
}

export type Paint = (color: string, text: string) => string;

export interface PlanViewerView {
	/** Pre-wrapped plain-text plan lines (wrapPlanText output for this width). */
	lines: string[];
	offset: number;
	choice: PlanChoice;
	/** Labels for the numbered choice list; the last is conventionally "Keep planning". */
	choices: readonly string[];
	maxVisible?: number;
}

export function renderPlanViewer(view: PlanViewerView, paint: Paint, width: number): string[] {
	const maxVisible = view.maxVisible ?? 12;
	// Cut plain text before painting so escapes never enter the width math.
	const cut = (line: string) => cutPlainText(line, width);
	const rule = paint("dim", "─".repeat(Math.max(0, Math.min(width, 72))));
	const pickHint = view.choices.length > 1 ? `1-${view.choices.length} pick · ` : "";

	const out: string[] = [];
	out.push("");
	out.push(paint("accent", cut("Approve this plan?")));
	out.push(paint("dim", cut(`↑/↓ scroll · ←/→ switch choice · ${pickHint}enter confirm · esc keep planning`)));
	out.push(rule);

	const offset = clampOffset(view.offset, view.lines.length, maxVisible);
	for (const line of view.lines.slice(offset, offset + maxVisible)) {
		out.push(cut(line));
	}
	if (view.lines.length > maxVisible) {
		const last = Math.min(view.lines.length, offset + maxVisible);
		out.push(paint("dim", cut(`lines ${offset + 1}–${last} of ${view.lines.length}`)));
	}
	out.push(rule);

	for (const [index, label] of view.choices.entries()) {
		const numbered = `${index + 1}. ${label}`;
		out.push(
			index === view.choice ? paint("accent", cut(`❯ ${numbered}`)) : cut(`  ${numbered}`),
		);
	}
	out.push("");
	return out;
}
