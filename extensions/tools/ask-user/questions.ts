/**
 * The questions ask_user_question asks and the answers it collects, as data
 * (pure). One Code's wording of the results is in profile/text/ask-user/.
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
