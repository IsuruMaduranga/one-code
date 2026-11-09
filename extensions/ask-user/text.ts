/**
 * What ask_user_question needs from a profile (types only). The base asks
 * and collects the answers as data (questions.ts); the profile words the
 * tool and its results (working-docs/features/profiles/).
 */

import type { DescriptionForm } from "../lib/profile/tool-variants.ts";
import type { Answer, Question } from "./questions.ts";

export interface AskUserText {
	/** Short or long by the model's tier (lib/profile/tool-variants.ts). */
	description(form: DescriptionForm): string;
	/** The one-line entry in the system prompt's tool list. */
	promptSnippet: string;
	params: Record<"questions" | "question" | "header" | "options" | "multiSelect" | "label" | "optionDescription" | "preview", string>;
	/** The session has no UI to show the questions in. */
	noInteractiveUi: string;
	/** The user submitted their answers. */
	answered(answers: readonly Answer[]): string;
	/** The user dismissed the dialog; `partial` holds what they had picked by then. */
	cancelled(partial: readonly Answer[]): string;
	/** The user chose to discuss the questions in chat instead. */
	declined(questions: readonly Question[]): string;
}
