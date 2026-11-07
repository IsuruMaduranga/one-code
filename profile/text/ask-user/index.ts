/**
 * One Code's ask_user_question text (the profile's `text.askUser`): Claude
 * Code's AskUserQuestion description and parameter docs (description.ts) and
 * its result wording.
 */

import type { AskUserText } from "../../../extensions/ask-user/text.ts";
import type { Answer, Question } from "../../../extensions/ask-user/questions.ts";
import { ASK_PARAMS, askDescription } from "./description.ts";
import { type ToolPassages, withoutOff } from "../../live-tools.ts";
import type { LiveTools } from "../../../extensions/lib/live-tools.ts";

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

/** Names both plan-mode tools: cut when either is off. */
const PLAN_MODE_PASSAGE = ["\n\nPlan mode note: To switch into plan mode, use enter_plan_mode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask \"Is my plan ready?\", \"Should I proceed?\", or otherwise reference \"the plan\" in questions — plan approval goes through exit_plan_mode."] as const;

const ASK_PASSAGES: ToolPassages = {
	enter_plan_mode: PLAN_MODE_PASSAGE,
	exit_plan_mode: PLAN_MODE_PASSAGE,
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const askUserText = (live: LiveTools): AskUserText => ({
	description: (form) => withoutOff(askDescription(form), live, ASK_PASSAGES),
	promptSnippet: "Ask the user to decide between options when genuinely blocked",
	params: ASK_PARAMS,
	noInteractiveUi:
		"This session has no interactive UI, so the user cannot be shown a dialog. Ask your question in your reply instead and stop, or proceed under a stated assumption.",
	answered: formatAnswers,
	cancelled: (partial) =>
		partial.length > 0
			? `The user cancelled without submitting. They had made these selections before cancelling (NOT submitted — do not treat them as final answers): ${answerPairs(partial)}.`
			: "The user cancelled without answering.",
	declined: formatDecline,
});
