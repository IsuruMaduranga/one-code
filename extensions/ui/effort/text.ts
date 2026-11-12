/** What `/effort` needs from a profile (types only): the ultracode reminders. */
export interface EffortText {
	/** The standing reminder while ultracode is on (every turn). */
	ultracodeOn: string;
	/** Said once when ultracode goes off after the model read the standing reminder. */
	ultracodeOff: string;
}
