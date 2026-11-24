/** The recap's words: the profile supplies its prompt (`RecapText`); the stub's reason is here. */
export interface RecapText {
	/** The instruction sent after the recent messages. */
	prompt: string;
}

/** The group's results, refusals and notes, which the base words (`recapResultText`). */
export interface RecapResultText {
	/** The description on the name-only tool stubs sent with the recap. */
	stubReason: string;
	/**
	 * Added to a session's first recaps. Claude Code's says "(turn off recaps in
	 * /config)"; here the switch is the features-off variable `offVariable`.
	 */
	offHint: (offVariable: string) => string;
}

/** The base's words of the group. */
export const recapResultText: RecapResultText = {
	stubReason: "Unavailable during this summary; answer in text.",
	offHint: (offVariable) => `(turn off recaps with ${offVariable}=recap)`,
};
