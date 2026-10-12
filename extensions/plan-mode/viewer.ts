/**
 * Plan-approval viewer (pure): key decoding, wrapping, and rendering for the
 * scrollable dialog exit_plan_mode shows. The thin ctx.ui.custom component in
 * index.ts owns nothing but mutable state and repaint calls — same split as
 * auto-mode's model picker.
 *
 * Every rendered line must stay within the width given: pi-tui crashes the
 * whole app on an overwide line. Content is wrapped (not truncated — a plan
 * must stay readable in full) and then cut ANSI-aware as a guard, and chrome
 * lines are cut plain-text *before* painting so ANSI escapes never confuse
 * the width accounting.
 */

import { cutPlainText, truncateLine, wrapProse } from "../lib/tui-render.ts";
import { keyId } from "../lib/key-input.ts";

/** Renders Markdown to painted lines at a width (pi-tui's Markdown, which the transcript uses). */
export type PlanMarkdown = (text: string, width: number) => string[];

/**
 * The plan's lines at `width`: Markdown rendered the way the transcript renders
 * assistant text when a renderer is available, else plain text wrapped at word
 * boundaries. A renderer that throws falls back to the plain wrap, so a
 * Markdown failure never costs the user the plan.
 */
export function planLines(plan: string, width: number, markdown?: PlanMarkdown): string[] {
	if (markdown) {
		try {
			return markdown(plan, width);
		} catch {
			// fall through to the plain wrap
		}
	}
	return wrapProse(plan, width);
}

/** What the dialog resolves to; index into the choices list, or null for cancel. */
export type PlanChoice = number;

/**
 * The approval through a plain select, for RPC: its `custom()` resolves
 * undefined (findings §8), which read as "dismissed" and rejected every plan.
 * The plan rides in the title; a reply that is no choice is a dismissal.
 */
export async function selectPlanChoice(
	ui: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> },
	plan: string,
	path: string,
	choices: string[],
	signal?: AbortSignal,
): Promise<PlanChoice | null> {
	const label = await ui.select(`Plan (${path}):\n\n${plan}\n\nApprove the plan?`, choices, { signal });
	const index = signal?.aborted || label === undefined ? -1 : choices.indexOf(label);
	return index >= 0 ? index : null;
}

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
	const id = keyId(data);
	switch (id) {
		case "up":
			return { kind: "scroll", delta: -1 };
		case "down":
			return { kind: "scroll", delta: 1 };
		case "pageUp":
			return { kind: "scroll", delta: -page };
		case "pageDown":
			return { kind: "scroll", delta: page };
		case "left":
			return { kind: "choice", delta: -1 };
		case "right":
		case "tab":
			return { kind: "choice", delta: 1 };
		case "enter":
			return { kind: "confirm" };
		case "escape":
		case "ctrl+c": // same intent as escape while the dialog is focused
			return { kind: "cancel" };
		default:
			if (id && id.length === 1 && id >= "1" && id <= "9") {
				return { kind: "pick", index: Number(id) - 1 };
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
/**
 * The pre-selected choice: the option that restores the mode the session was
 * in before planning when one is offered (Claude Code's ExitPlanMode restores
 * `prePlanMode`), else "manual approvals", else the first option.
 */
export function initialPlanChoice(options: readonly { mode?: string; restore?: boolean }[]): PlanChoice {
	const restore = options.findIndex((o) => o.restore);
	if (restore >= 0) return restore;
	const index = options.findIndex((o) => o.mode === "default");
	return index >= 0 ? index : 0;
}

export type Paint = (color: string, text: string) => string;

export interface PlanViewerView {
	/** The plan's lines for this width (planLines output: painted Markdown or plain wrapped text). */
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
	const rule = paint("dim", "─".repeat(Math.max(0, width)));
	const pickHint = view.choices.length > 1 ? `1-${view.choices.length} pick · ` : "";

	const out: string[] = [];
	out.push("");
	out.push(paint("accent", cut("Approve this plan?")));
	out.push(paint("dim", cut(`↑/↓ scroll · ←/→ switch choice · ${pickHint}enter confirm · esc cancel`)));
	out.push(rule);

	// Plan lines may arrive painted (Markdown), so the guard cut is ANSI-aware.
	const offset = clampOffset(view.offset, view.lines.length, maxVisible);
	for (const line of view.lines.slice(offset, offset + maxVisible)) {
		out.push(truncateLine(line, width));
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

/** The question the keep-planning choice asks (Claude Code's placeholder, naming the agent). */
export const KEEP_PLANNING_QUESTION = "Tell the agent what to change";

/** How the approval ended: an approving choice, or a rejection carrying the user's words when they gave some. */
export type PlanDecision = { kind: "approve"; index: PlanChoice } | { kind: "reject"; feedback?: string };

/**
 * The approval flow, as in Claude Code: keeping planning asks what to change,
 * and those words go back to the model, which keeps planning. A blank answer
 * returns to the dialog (Claude Code ignores Enter on an empty "keep planning"
 * input). Esc on the dialog or on the question rejects without words, which
 * stops the turn. The option without a mode is the keep-planning one.
 */
export async function runPlanApproval(
	options: readonly { mode?: string }[],
	showDialog: () => Promise<PlanChoice | null>,
	askFeedback: () => Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<PlanDecision> {
	for (;;) {
		const choice = await showDialog();
		if (choice == null || signal?.aborted) return { kind: "reject" };
		if (options[choice]?.mode) return { kind: "approve", index: choice };
		const feedback = await askFeedback();
		if (feedback === undefined || signal?.aborted) return { kind: "reject" };
		if (feedback.trim()) return { kind: "reject", feedback: feedback.trim() };
	}
}
