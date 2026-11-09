/** What `/btw` needs from a profile (types only). */
export interface BtwText {
	/** The final user message of a side question; `question` is already trimmed. */
	question(question: string): string;
	/** The description on the name-only tool stubs sent with a side question. */
	stubReason: string;
}
