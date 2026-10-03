/**
 * Question and answer shaping for ask_user_question (pure).
 */

export interface QuestionOption {
	label: string;
	description?: string;
	/** Rendered beside the options while this option is focused (single-select only). */
	preview?: string;
}

export interface Question {
	question: string;
	header: string;
	multiSelect?: boolean;
	options: QuestionOption[];
}

export interface Answer {
	question: string;
	header: string;
	selected: string[];
	/** True when the user typed their own answer instead of picking. */
	freeform: boolean;
	/** True when the answer includes text the user typed (the "Other" row), alone or beside picked options. */
	typed?: boolean;
	/** The preview of the single option picked, when it carries one. */
	preview?: string;
	/** Free-text notes the user attached to this answer. */
	notes?: string;
}

/**
 * Claude Code's answer list: `"question"="answer"` per answered question, with
 * the picked option's preview and the user's notes, joined by ", ". A question
 * left unanswered is listed only when it carries notes.
 */
export function answerPairs(answers: Answer[]): string {
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
export function formatAnswers(answers: Answer[]): string {
	const pairs = answerPairs(answers);
	if (!pairs) return "The user did not answer the questions.";
	const fromOptions = answers.every((answer) => !answer.notes && !answer.typed && !answer.freeform);
	return fromOptions
		? `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`
		: `The user answered: ${pairs}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
}

/** Tool result when the user picks "Chat about this" instead of answering. */
export function formatDecline(questions: Question[]): string {
	const list = questions
		.map((q) => `· ${q.question} (${q.options.map((o) => o.label).join(" / ")})`)
		.join("\n");
	return `The user declined to answer and wants to chat about these questions instead:\n\n${list}\n\nAsk them in your reply what they'd like to clarify; don't call ask_user_question again until the discussion resolves it.`;
}
