/**
 * The multi-question widget behind ask_user_question (pure): state machine and
 * rendering for Claude Code's tabbed question dialog — one tab per question
 * plus Submit, a side-by-side preview pane on single-select questions whose
 * options carry `preview`, per-question notes ("press n to add notes"),
 * multi-select checkboxes, an inline free-text row, and "Chat about this",
 * which hands the whole batch back to the conversation. The thin ctx.ui.custom
 * component in index.ts owns nothing but this state and repaint calls — same
 * split as plan-mode's viewer.
 *
 * Every rendered line must stay within the width given: pi-tui crashes the
 * whole app on an overwide line, so renderWidget runs each line through the
 * ANSI-aware truncateLine as a final guard, cutting plain text before
 * painting wherever it can along the way.
 */

import { cutPlainText, padPlainText, truncateLine, wrapPlainText } from "../lib/tui-render.ts";
import type { Answer, Question } from "./questions.ts";

export type Paint = (color: string, text: string) => string;
export type Bold = (text: string) => string;

/** The theme surface the widget paints with (safeTheme* wrappers from index.ts). */
export interface WidgetStyle {
	paint: Paint;
	bold: Bold;
	/** Reverse video — the active tab's background chip. */
	inverse: (text: string) => string;
}

const TAB_UNANSWERED = "⊡";
const TAB_ANSWERED = "⊠";
const OTHER_PLACEHOLDER = "Type something.";
const CHAT_LABEL = "Chat about this";
const NOTES_PLACEHOLDER = "press n to add notes";
const MAX_PREVIEW_ROWS = 12;

// ── state ────────────────────────────────────────────────────────────────

export interface QuestionState {
	cursor: number;
	/** Selected option indices (at most one unless multiSelect). */
	selected: number[];
	otherText: string;
	/** Typed free-text is part of the answer. Only ever set with a non-empty otherText. */
	otherChosen: boolean;
	notes: string;
	/** Multi-select "Next" pressed — counts as answered even with nothing ticked. */
	committed: boolean;
}

export interface WidgetState {
	questions: Question[];
	/** 0..N-1 = question tabs, N = the Submit tab. */
	tab: number;
	/** Present while typing into the free-text row or the notes line. */
	editing?: { field: "other" | "notes"; draft: string };
	qs: QuestionState[];
}

export type WidgetResult =
	| { kind: "submit"; answers: Answer[] }
	| { kind: "chat" }
	/** Esc; `answers` holds what the user had picked on other tabs, never submitted. */
	| { kind: "cancel"; answers: Answer[] };

export function createWidgetState(questions: Question[]): WidgetState {
	return {
		questions,
		tab: 0,
		qs: questions.map(() => ({
			cursor: 0,
			selected: [],
			otherText: "",
			otherChosen: false,
			notes: "",
			committed: false,
		})),
	};
}

// ── row model ────────────────────────────────────────────────────────────

export type Row = { kind: "option"; index: number } | { kind: "other" } | { kind: "next" } | { kind: "chat" };

/** Preview pane applies to single-select questions with at least one preview. */
export function hasPreviews(question: Question): boolean {
	return !question.multiSelect && question.options.some((option) => Boolean(option.preview?.trim()));
}

/**
 * Preview questions get no free-text row (notes are their free-text channel,
 * matching Claude Code); every other question gets one. Multi-select adds an
 * explicit "Next" to commit. "Chat about this" is always last.
 */
export function rowsFor(question: Question): Row[] {
	const rows: Row[] = question.options.map((_, index) => ({ kind: "option", index }));
	if (!hasPreviews(question)) rows.push({ kind: "other" });
	if (question.multiSelect) rows.push({ kind: "next" });
	rows.push({ kind: "chat" });
	return rows;
}

/**
 * Display numbers per row — the single source for both rendering and digit
 * jumps, so a digit can only ever activate a row whose number is on screen.
 * "Next" gets none (Claude Code leaves it unnumbered), and the preview layout
 * shows "Chat about this" unnumbered too.
 */
export function rowNumbers(question: Question, rows: Row[]): (number | undefined)[] {
	const unnumbered = (row: Row) => row.kind === "next" || (row.kind === "chat" && hasPreviews(question));
	let count = 0;
	return rows.map((row) => (unnumbered(row) ? undefined : ++count));
}

export function isAnswered(state: QuestionState): boolean {
	return state.committed || state.selected.length > 0 || state.otherChosen;
}

// ── key handling ─────────────────────────────────────────────────────────

export type WidgetKey =
	| { kind: "up" | "down" | "prevTab" | "nextTab" | "enter" | "esc" | "backspace" }
	| { kind: "text"; text: string };

export function decodeWidgetKey(data: string): WidgetKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
			return { kind: "down" };
		case "\x1b[D":
		case "\x1bOD":
		case "\x1b[Z": // shift+tab
			return { kind: "prevTab" };
		case "\x1b[C":
		case "\x1bOC":
		case "\t":
			return { kind: "nextTab" };
		case "\r":
		case "\n":
			return { kind: "enter" };
		case "\x1b":
		case "\x03": // ctrl+c — same intent as escape while the dialog is focused
			return { kind: "esc" };
		case "\x7f":
		case "\b":
			return { kind: "backspace" };
		default: {
			// Unrecognized escape sequences (home/end/F-keys) must not leak their
			// tail characters into a text draft.
			if (data.startsWith("\x1b")) return undefined;
			const text = [...data].filter((char) => char >= " " && char !== "\x7f").join("");
			return text ? { kind: "text", text } : undefined;
		}
	}
}

/**
 * Advance one key. Mutates `state`; returns a result when the dialog is done.
 */
export function applyWidgetKey(state: WidgetState, key: WidgetKey): WidgetResult | undefined {
	if (state.editing) return applyEditingKey(state, key);

	const submitTab = state.questions.length;
	switch (key.kind) {
		case "esc":
			return { kind: "cancel", answers: answeredSoFar(state) };
		case "nextTab":
			state.tab = (state.tab + 1) % (submitTab + 1);
			return;
		case "prevTab":
			state.tab = (state.tab + submitTab) % (submitTab + 1);
			return;
		default:
			break;
	}

	if (state.tab === submitTab) {
		if (key.kind === "enter") {
			const unanswered = state.questions.findIndex((_q, i) => !isAnswered(state.qs[i]));
			if (unanswered >= 0) {
				state.tab = unanswered;
				return;
			}
			return { kind: "submit", answers: collectAnswers(state) };
		}
		return;
	}

	const question = state.questions[state.tab];
	const questionState = state.qs[state.tab];
	const rows = rowsFor(question);

	switch (key.kind) {
		case "up":
			questionState.cursor = Math.max(0, questionState.cursor - 1);
			return;
		case "down":
			questionState.cursor = Math.min(rows.length - 1, questionState.cursor + 1);
			return;
		case "enter":
			return activateRow(state, rows[questionState.cursor]);
		case "text": {
			if (key.text === "n" && hasPreviews(question)) {
				state.editing = { field: "notes", draft: questionState.notes };
				return;
			}
			const digit = Number(key.text);
			const target = rowNumbers(question, rows).indexOf(digit);
			if (target >= 0) {
				questionState.cursor = target;
				return activateRow(state, rows[target]);
			}
			return;
		}
		default:
			return;
	}
}

function activateRow(state: WidgetState, row: Row): WidgetResult | undefined {
	const question = state.questions[state.tab];
	const questionState = state.qs[state.tab];
	switch (row.kind) {
		case "option": {
			if (question.multiSelect) {
				const at = questionState.selected.indexOf(row.index);
				if (at >= 0) questionState.selected.splice(at, 1);
				else questionState.selected.push(row.index);
				return;
			}
			questionState.selected = [row.index];
			questionState.otherChosen = false;
			advance(state);
			return;
		}
		case "other":
			state.editing = { field: "other", draft: questionState.otherText };
			return;
		case "next":
			questionState.committed = true;
			advance(state);
			return;
		case "chat":
			return { kind: "chat" };
	}
}

function applyEditingKey(state: WidgetState, key: WidgetKey): WidgetResult | undefined {
	const editing = state.editing;
	if (!editing) return;
	const question = state.questions[state.tab];
	const questionState = state.qs[state.tab];

	switch (key.kind) {
		case "esc":
			state.editing = undefined;
			return;
		case "backspace":
			editing.draft = editing.draft.slice(0, -1);
			return;
		case "text":
			editing.draft += key.text;
			return;
		case "enter": {
			state.editing = undefined;
			if (editing.field === "notes") {
				questionState.notes = editing.draft.trim();
				return;
			}
			questionState.otherText = editing.draft.trim();
			questionState.otherChosen = questionState.otherText !== "";
			// A typed answer on a single-select question IS the answer.
			if (questionState.otherChosen && !question.multiSelect) {
				questionState.selected = [];
				advance(state);
			}
			return;
		}
		default:
			return; // arrows/tab are inert while typing
	}
}

/** Move to the next unanswered question, or the Submit tab when none remain. */
function advance(state: WidgetState): void {
	const count = state.questions.length;
	for (let step = 1; step < count; step++) {
		const i = (state.tab + step) % count;
		if (!isAnswered(state.qs[i])) {
			state.tab = i;
			return;
		}
	}
	state.tab = count;
}

// ── answers ──────────────────────────────────────────────────────────────

export function collectAnswer(question: Question, state: QuestionState): Answer {
	const labels = [...state.selected].sort((a, b) => a - b).map((index) => question.options[index].label);
	if (state.otherChosen) labels.push(state.otherText);
	return {
		question: question.question,
		header: question.header,
		selected: labels,
		freeform: labels.length > 0 && state.selected.length === 0,
		notes: state.notes || undefined,
	};
}

export function collectAnswers(state: WidgetState): Answer[] {
	return state.questions.map((question, i) => collectAnswer(question, state.qs[i]));
}

/** Answers for the questions already answered — what an Esc abandons. */
export function answeredSoFar(state: WidgetState): Answer[] {
	return state.questions.flatMap((question, i) =>
		isAnswered(state.qs[i]) ? [collectAnswer(question, state.qs[i])] : [],
	);
}

// ── rendering ────────────────────────────────────────────────────────────

export function renderWidget(state: WidgetState, style: WidgetStyle, width: number): string[] {
	const { paint } = style;
	const out: string[] = [paint("dim", "─".repeat(Math.max(0, width)))];
	out.push(renderTabBar(state, style));
	out.push("");
	if (state.tab === state.questions.length) renderSubmitTab(state, paint, width, out);
	else renderQuestionTab(state, style, width, out);
	out.push("");
	out.push(paint("dim", cutPlainText(footerFor(state), Math.max(1, width - 1))));
	// Final ANSI-aware guard: pi-tui crashes the app on an overwide line, and
	// the painted tab bar can exceed narrow widths.
	return out.map((line) => truncateLine(line, width));
}

/** Active tab is an accent chip (reverse video), like Claude Code's. */
function renderTabBar(state: WidgetState, style: WidgetStyle): string {
	const { paint, inverse } = style;
	const chip = (text: string, active: boolean) => (active ? inverse(paint("accent", ` ${text} `)) : ` ${text} `);
	const segments = state.questions.map((question, i) => {
		const glyph = isAnswered(state.qs[i]) ? TAB_ANSWERED : TAB_UNANSWERED;
		return chip(`${glyph} ${question.header}`, i === state.tab);
	});
	segments.push(chip("✔ Submit", state.tab === state.questions.length));
	return `${paint("dim", "←")} ${segments.join(" ")} ${paint("dim", "→")}`;
}

export function footerFor(state: WidgetState): string {
	if (state.editing) return "Enter to confirm · Esc to back out";
	if (state.tab === state.questions.length) return "Enter to submit · Tab to switch questions · Esc to cancel";
	// The preview layout spells out ↑/↓ and the notes key; the stacked layout
	// uses Claude Code's shorter wording.
	if (hasPreviews(state.questions[state.tab]))
		return "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel";
	return "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
}

function renderSubmitTab(state: WidgetState, paint: Paint, width: number, out: string[]): void {
	const cut = (line: string) => cutPlainText(line, Math.max(1, width - 1));
	for (const [i, question] of state.questions.entries()) {
		const questionState = state.qs[i];
		if (isAnswered(questionState)) {
			const answer = collectAnswer(question, questionState);
			const value = answer.selected.length > 0 ? answer.selected.join(", ") : "(nothing selected)";
			out.push(cut(`· ${question.question} → ${value}`));
		} else {
			out.push(paint("dim", cut(`· ${question.question} → (unanswered)`)));
		}
	}
	const ready = state.questions.every((_q, i) => isAnswered(state.qs[i]));
	out.push("");
	out.push(
		ready
			? paint("accent", cut("All questions answered — press Enter to submit."))
			: paint("dim", cut("Some questions are unanswered — Enter jumps to the first one.")),
	);
}

function renderQuestionTab(state: WidgetState, style: WidgetStyle, width: number, out: string[]): void {
	const question = state.questions[state.tab];
	for (const line of wrapPlainText(question.question, Math.max(10, width - 1))) out.push(style.bold(line));
	out.push("");
	if (hasPreviews(question)) renderPreviewRows(state, style, width, out);
	else renderStackedRows(state, style, width, out);
}

/** `❯` on the focused row; selection and focus both paint accent. */
function pointerFor(state: WidgetState, rowIndex: number): string {
	return !state.editing && state.qs[state.tab].cursor === rowIndex ? "❯" : " ";
}

/** The divider + "Chat about this" row both layouts end with (always the last row). */
function pushChatRow(state: WidgetState, rows: Row[], style: WidgetStyle, width: number, out: string[]): void {
	const { paint, bold } = style;
	const question = state.questions[state.tab];
	const rowIndex = rows.length - 1;
	const number = rowNumbers(question, rows)[rowIndex];
	const label = number === undefined ? CHAT_LABEL : `${number}. ${CHAT_LABEL}`;
	out.push(paint("dim", "─".repeat(Math.max(0, width - 1))));
	const line = bold(cutPlainText(`${pointerFor(state, rowIndex)} ${label}`, Math.max(1, width - 1)));
	const focused = !state.editing && state.qs[state.tab].cursor === rowIndex;
	out.push(focused ? paint("accent", line) : line);
}

function renderStackedRows(state: WidgetState, style: WidgetStyle, width: number, out: string[]): void {
	const { paint, bold } = style;
	const question = state.questions[state.tab];
	const questionState = state.qs[state.tab];
	const rows = rowsFor(question);
	const numbers = rowNumbers(question, rows);
	const cut = (line: string) => cutPlainText(line, Math.max(1, width - 1));
	// Claude Code's look: labels bold, descriptions muted underneath, the whole
	// focused/selected row accent on top of that. Overflow is handled by
	// renderWidget's final truncateLine pass.
	const labelRow = (prefix: string, label: string, highlight: boolean) => {
		const line = `${prefix}${bold(label)}`;
		return highlight ? paint("accent", line) : line;
	};

	for (const [r, row] of rows.entries()) {
		const focused = !state.editing && questionState.cursor === r;
		const pointer = pointerFor(state, r);
		const number = `${numbers[r]}.`;
		switch (row.kind) {
			case "option": {
				const option = question.options[row.index];
				const check = question.multiSelect ? (questionState.selected.includes(row.index) ? "[✔] " : "[ ] ") : "";
				const selected = questionState.selected.includes(row.index);
				out.push(labelRow(`${pointer} ${number} ${check}`, option.label, focused || selected));
				if (option.description) out.push(paint("muted", cut(`   ${" ".repeat(number.length)}${option.description}`)));
				break;
			}
			case "other": {
				const editing = state.editing?.field === "other";
				const check = question.multiSelect ? (questionState.otherChosen ? "[✔] " : "[ ] ") : "";
				if (editing) {
					out.push(paint("accent", cut(`❯ ${number} ${check}${state.editing?.draft ?? ""}▏`)));
				} else if (questionState.otherText) {
					out.push(labelRow(`${pointer} ${number} ${check}`, questionState.otherText, focused || questionState.otherChosen));
				} else {
					out.push(labelRow(`${pointer} ${number} ${check}`, OTHER_PLACEHOLDER, focused));
				}
				break;
			}
			case "next": {
				const line = bold(cut(`${pointer}    Next`));
				out.push(focused ? paint("accent", line) : line);
				break;
			}
			case "chat":
				pushChatRow(state, rows, style, width, out);
				break;
		}
	}
}

function renderPreviewRows(state: WidgetState, style: WidgetStyle, width: number, out: string[]): void {
	const { paint } = style;
	const question = state.questions[state.tab];
	const questionState = state.qs[state.tab];
	const rows = rowsFor(question);
	const numbers = rowNumbers(question, rows);
	const cut = (line: string) => cutPlainText(line, Math.max(1, width - 1));

	// Left column: numbered option labels, padded plain before painting so the
	// ANSI escapes never enter the width math.
	const leftPlain = question.options.map((option, i) => `${pointerFor(state, i)} ${numbers[i]}. ${option.label}`);
	const leftWidth = Math.min(
		Math.max(...leftPlain.map((line) => [...line].length)) + 2,
		Math.max(12, Math.floor(width * 0.45)),
	);
	const leftLines = leftPlain.map((line, i) => {
		const padded = padPlainText(line, leftWidth);
		const focused = !state.editing && questionState.cursor === i;
		return focused || questionState.selected.includes(i) ? paint("accent", padded) : padded;
	});

	// The preview follows the focused option (falling back to the selection).
	const focusIndex =
		questionState.cursor < question.options.length ? questionState.cursor : (questionState.selected[0] ?? 0);
	const preview = question.options[focusIndex]?.preview?.trim();
	const boxWidth = Math.max(0, width - leftWidth - 2);
	const sideBySide = boxWidth >= 18;
	const box = preview ? previewBox(preview, sideBySide ? boxWidth : Math.max(18, width - 3), paint) : [];

	if (sideBySide) {
		for (let i = 0; i < Math.max(leftLines.length, box.length); i++) {
			out.push(`${leftLines[i] ?? " ".repeat(leftWidth)}${box[i] ?? ""}`);
		}
	} else {
		out.push(...leftLines.map((line) => line.trimEnd()));
		if (box.length > 0) {
			out.push("");
			out.push(...box.map((line) => `  ${line}`));
		}
	}

	// Notes sit under the preview, aligned with the box when side by side.
	const notesIndent = " ".repeat(sideBySide ? leftWidth : 2);
	out.push("");
	if (state.editing?.field === "notes") {
		out.push(`${notesIndent}${paint("accent", "Notes: ")}${cut(state.editing.draft)}▏`);
	} else if (questionState.notes) {
		out.push(`${notesIndent}${paint("accent", "Notes: ")}${cut(questionState.notes)}`);
	} else {
		out.push(`${notesIndent}${paint("accent", "Notes: ")}${paint("dim", NOTES_PLACEHOLDER)}`);
	}

	out.push("");
	pushChatRow(state, rows, style, width, out);
}

function previewBox(preview: string, maxOuter: number, paint: Paint): string[] {
	const inner = Math.max(8, maxOuter - 4);
	const wrapped = wrapPlainText(preview.replace(/\t/g, "  "), inner);
	const shown = wrapped.slice(0, MAX_PREVIEW_ROWS);
	const hidden = wrapped.length - shown.length;
	const contentWidth = Math.min(inner, Math.max(8, ...shown.map((line) => [...line].length)));
	const border = paint("dim", "│");
	const body = shown.map((line) => `${border} ${padPlainText(line, contentWidth)} ${border}`);
	if (hidden > 0) body.push(`${border} ${paint("dim", padPlainText(`… +${hidden} more lines`, contentWidth))} ${border}`);
	return [
		paint("dim", `┌${"─".repeat(contentWidth + 2)}┐`),
		...body,
		paint("dim", `└${"─".repeat(contentWidth + 2)}┘`),
	];
}
