import type { EffortChoice } from "../../lib/ui/effort-slider.ts";

/** What `/effort` needs from a profile (types only): the ultracode reminders. */
export interface EffortText {
	/** The standing reminder while ultracode is on (every turn). */
	ultracodeOn: string;
	/** Said once when ultracode goes off after the model read the standing reminder. */
	ultracodeOff: string;
	/**
	 * A line for the user under the `/effort` slider's track, worded for the
	 * highlighted stop (a thinking level, or `"ultracode"`) and asked again each
	 * time the marker moves. Only its first line is shown, trimmed, clipped to
	 * the terminal width; `undefined` or an empty text draws no row, and a throw
	 * counts as none. Left out, the slider is unchanged. It is for the person at
	 * the terminal and never enters a request.
	 */
	sliderNote?: (choice: EffortChoice) => string | undefined;
}
