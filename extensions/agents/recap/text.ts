/** What the recap needs from a profile (types only). */
export interface RecapText {
	/** The instruction sent after the recent messages. */
	prompt: string;
	/** The description on the name-only tool stubs sent with the recap. */
	stubReason: string;
}
