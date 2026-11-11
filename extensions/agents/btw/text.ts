/** `/btw`'s words: the profile supplies the side question's prompt (`BtwText`); the stub's reason is here. */
export interface BtwText {
	/** The final user message of a side question; `question` is already trimmed. */
	question(question: string): string;
}

/** The group's results, refusals and notes, which the base words (`btwResultText`). */
export interface BtwResultText {
	/** The description on the name-only tool stubs sent with a side question. */
	stubReason: string;
}

/** The base's words of the group. */
export const btwResultText: BtwResultText = {
	stubReason: "Unavailable during this side question; answer in text.",
};
