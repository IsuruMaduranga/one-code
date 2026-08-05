/**
 * Question and answer shaping for ask_user_question (pure).
 */

export interface QuestionOption {
	label: string;
	description?: string;
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
}

export const OTHER_LABEL = "Other (type your own answer)";
export const DONE_LABEL = "Done selecting";

/** `label — description`, so the description is visible in a plain select list. */
export function formatOptionLabel(option: QuestionOption): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

/** Maps a chosen display string back to the option label it came from. */
export function resolveSelection(display: string, options: QuestionOption[]): string | undefined {
	return options.find((option) => formatOptionLabel(option) === display)?.label;
}

export function buildChoices(question: Question, alreadySelected: string[] = []): string[] {
	const marked = question.options.map((option) => {
		const label = formatOptionLabel(option);
		return question.multiSelect && alreadySelected.includes(option.label) ? `✓ ${label}` : label;
	});
	const extras = question.multiSelect ? [DONE_LABEL, OTHER_LABEL] : [OTHER_LABEL];
	return [...marked, ...extras];
}

/** Strips the multi-select tick so the choice can be matched against options. */
export function stripMark(display: string): string {
	return display.startsWith("✓ ") ? display.slice(2) : display;
}

export function formatAnswers(answers: Answer[]): string {
	if (answers.length === 0) return "The user did not answer.";
	return answers
		.map((answer) => {
			const value = answer.selected.length > 0 ? answer.selected.join(", ") : "(no answer)";
			return `${answer.question}\n→ ${value}${answer.freeform ? " (typed by the user)" : ""}`;
		})
		.join("\n\n");
}
