/**
 * ask_user_question's words. The extension asks and collects the answers as
 * data (questions.ts). The profile words the tool itself (`AskUserText`:
 * description, prompt snippet, parameters); the answers, the decline and the
 * refusal without a user are here (`askUserResultText`).
 */

import type { DescriptionForm } from "../../lib/profile/tool-variants.ts";
import type { Answer, Question } from "./questions.ts";

export interface AskUserText {
	/** Short or long by the model's tier (lib/profile/tool-variants.ts). */
	description(form: DescriptionForm): string;
	/** The one-line entry in the system prompt's tool list. */
	promptSnippet: string;
	params: Record<"questions" | "question" | "header" | "options" | "multiSelect" | "label" | "optionDescription" | "preview", string>;
}

/** The group's results, refusals and notes, which the base words (`askUserResultText`). */
export interface AskUserResultText {
	/** The session has no UI to show the questions in. */
	noInteractiveUi: string;
	/** The user submitted their answers. */
	answered(answers: readonly Answer[]): string;
	/** The user dismissed the dialog; `partial` holds what they had picked by then. */
	cancelled(partial: readonly Answer[]): string;
	/** The user chose to discuss the questions in chat instead. */
	declined(questions: readonly Question[]): string;
}

/**
 * Claude Code's answer list: `"question"="answer"` per answered question, with
 * the picked option's preview and the user's notes, joined by ", ". A question
 * left unanswered is listed only when it carries notes.
 */
export function answerPairs(answers: readonly Answer[]): string {
	return answers
		.map((answer) => {
			const answered = answer.selected.length > 0;
			if (!answered && !answer.notes) return undefined;
			const parts = [answered ? `"${answer.question}"="${answer.selected.join(", ")}"` : `"${answer.question}"=(no option selected)`];
			if (answer.preview) parts.push(`selected preview:\n${answer.preview}`);
			if (answer.notes) parts.push(`notes: ${answer.notes}`);
			return parts.join(" ");
		})
		.filter((pair): pair is string => pair !== undefined)
		.join(", ");
}

/**
 * ask_user_question's result, in Claude Code's words. Answers picked from the
 * offered options are confirmed; an answer the user typed, or one with notes,
 * may redirect the task, so the model is told to read it carefully.
 */
export function formatAnswers(answers: readonly Answer[]): string {
	const pairs = answerPairs(answers);
	if (!pairs) return "The user did not answer the questions.";
	const fromOptions = answers.every((answer) => !answer.notes && !answer.typed && !answer.freeform);
	return fromOptions
		? `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`
		: `The user answered: ${pairs}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
}

/** Tool result when the user picks "Chat about this" instead of answering. */
export function formatDecline(questions: readonly Question[]): string {
	const list = questions
		.map((q) => `· ${q.question} (${q.options.map((o) => o.label).join(" / ")})`)
		.join("\n");
	return `The user declined to answer and wants to chat about these questions instead:\n\n${list}\n\nAsk them in your reply what they'd like to clarify; don't call ask_user_question again until the discussion resolves it.`;
}

/** The base's words of the group. */
export const askUserResultText: AskUserResultText = {
	noInteractiveUi:
		"This session has no interactive UI, so the user cannot be shown a dialog. Ask your question in your reply instead and stop, or proceed under a stated assumption.",
	answered: formatAnswers,
	cancelled: (partial) =>
		partial.length > 0
			? `The user cancelled without submitting. They had made these selections before cancelling (NOT submitted — do not treat them as final answers): ${answerPairs(partial)}.`
			: "The user cancelled without answering.",
	declined: formatDecline,
};
