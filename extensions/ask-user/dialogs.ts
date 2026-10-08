/**
 * ask_user_question through pi's plain dialogs (pure).
 *
 * pi's RPC mode returns `undefined` from `ctx.ui.custom()` ("Custom UI not
 * supported in RPC mode"), so the tabbed widget never reaches an RPC client and
 * the tool used to report "The user cancelled without answering." RPC does
 * forward `select` and `input` as `extension_ui_request`s, so this asks each
 * question with them and returns the widget's result shape: the same tool
 * result the TUI produces. A dismissed dialog cancels with the answers given so
 * far, as Esc does in the widget.
 */

import type { Answer, Question } from "./questions.ts";
import type { WidgetResult } from "./widget.ts";

export const TYPE_OWN = "Type my own answer";
export const CHAT = "Chat about this";
export const DONE = "Done";

export interface DialogUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** One option's row: its label, and its description after a dash when it has one. */
export function optionRow(option: { label: string; description?: string }): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

export async function askThroughDialogs(questions: Question[], ui: DialogUI): Promise<WidgetResult> {
	const answers: Answer[] = [];
	for (const question of questions) {
		const title = `${question.header}: ${question.question}`;
		const plainRows = question.options.map(optionRow);
		// RPC identifies a selection by its displayed string. Number every option
		// when a row collides with another option or one of our control rows.
		const numbered = new Set(plainRows).size !== plainRows.length || plainRows.some((row) => [DONE, TYPE_OWN, CHAT].includes(row));
		const rows = plainRows.map((row, index) => (numbered ? `${index + 1}. ${row}` : row));
		const selected: string[] = [];
		let typed: string | undefined;
		for (;;) {
			const choices = [
				...question.options.flatMap((option, index) => (selected.includes(option.label) ? [] : [rows[index]])),
				...(question.multiSelect && selected.length > 0 ? [DONE] : []),
				TYPE_OWN,
				CHAT,
			];
			const picked = await ui.select(question.multiSelect && selected.length > 0 ? `${title} (selected: ${selected.join(", ")})` : title, choices);
			if (picked === undefined) return { kind: "cancel", answers };
			if (picked === CHAT) return { kind: "chat" };
			if (picked === DONE) break;
			if (picked === TYPE_OWN) {
				const text = (await ui.input(title, "Type something."))?.trim();
				if (text === undefined) return { kind: "cancel", answers };
				// A blank answer is no answer: ask the question again.
				if (!text) continue;
				typed = text;
				break;
			}
			const option = question.options[rows.indexOf(picked)];
			if (!option) return { kind: "cancel", answers };
			selected.push(option.label);
			if (!question.multiSelect || selected.length === question.options.length) break;
		}
		const all = typed === undefined ? selected : [...selected, typed];
		const single = !question.multiSelect && selected.length === 1 ? question.options.find((o) => o.label === selected[0]) : undefined;
		answers.push({
			question: question.question,
			header: question.header,
			selected: all,
			freeform: typed !== undefined && selected.length === 0,
			...(typed !== undefined ? { typed: true } : {}),
			...(single?.preview ? { preview: single.preview } : {}),
		});
	}
	return { kind: "submit", answers };
}
