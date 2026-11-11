/** What the recap needs from a profile (types only). */
export interface RecapText {
	/** The instruction sent after the recent messages. */
	prompt: string;
}

/** The group's results, refusals and notes, which the base words (`recapResultText`). */
export interface RecapResultText {
	/** The description on the name-only tool stubs sent with the recap. */
	stubReason: string;
}

/** The base's words of the group. */
export const recapResultText: RecapResultText = {
	stubReason: "Unavailable during this summary; answer in text.",
};
