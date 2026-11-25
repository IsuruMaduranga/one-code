/** The recap's words: the profile supplies its prompt (`RecapText`); the stub's reason is here. */
export interface RecapText {
	/** The instruction sent after the recent messages. */
	prompt: string;
}

/** The group's results, refusals and notes, which the base words (`recapResultText`). */
export interface RecapResultText {
	/** The description on the name-only tool stubs sent with the recap. */
	stubReason: string;
	/** Added to a session's first recaps: where to turn them off (Claude Code's words; /config is commands/config). */
	offHint: string;
	/** The same, when the profile has no /config: the features-off variable `offVariable`. */
	offHintWithoutConfig: (offVariable: string) => string;
}

/** The base's words of the group. */
export const recapResultText: RecapResultText = {
	stubReason: "Unavailable during this summary; answer in text.",
	offHint: "(turn off recaps in /config)",
	offHintWithoutConfig: (offVariable) => `(turn off recaps with ${offVariable}=recap)`,
};
