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
	/** Free-text notes the user attached to this answer. */
	notes?: string;
}

export function formatAnswers(answers: Answer[]): string {
	if (answers.length === 0) return "The user did not answer.";
	return answers
		.map((answer) => {
			const value = answer.selected.length > 0 ? answer.selected.join(", ") : "(no answer)";
			const typed = answer.freeform ? " (typed by the user)" : "";
			const notes = answer.notes ? `\n→ notes: ${answer.notes}` : "";
			return `${answer.question}\n→ ${value}${typed}${notes}`;
		})
		.join("\n\n");
}

/** Tool result when the user picks "Chat about this" instead of answering. */
export function formatDecline(questions: Question[]): string {
	const list = questions
		.map((q) => `· ${q.question} (${q.options.map((o) => o.label).join(" / ")})`)
		.join("\n");
	return `The user declined to answer and wants to chat about these questions instead:\n\n${list}\n\nAsk them in your reply what they'd like to clarify; don't call ask_user_question again until the discussion resolves it.`;
}
