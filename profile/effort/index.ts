/** One Code's `/effort` text (the profile's `text.effort`): the ultracode reminders. */

import type { EffortText } from "../../extensions/effort/text.ts";

export const effort: EffortText = {
	/**
	 * Deliberately stronger than the single-turn keyword reminder: it makes
	 * orchestration the default for substantive work rather than something to
	 * consider, and still carves out the trivial cases so the mode does not
	 * spawn a fleet to rename a variable.
	 */
	ultracodeOn:
		"Ultracode mode is on, so the user's opt-in to multi-agent orchestration is standing: author and run a workflow for every substantive task by default, and lean toward adversarially verifying your findings. " +
		"For multi-phase work (understand → design → implement → review) that often means several workflows in sequence — one per phase — so you stay in the loop between them. " +
		"Token cost is not the constraint here; the most exhaustive correct answer is. " +
		"Work solo only on conversational turns and trivial mechanical edits.",
	/**
	 * The earlier messages keep the standing block in the record, so without
	 * this the model reads the opt-in as standing (lifecycle-grid-hunt round 3,
	 * R3-M21).
	 */
	ultracodeOff:
		"Ultracode mode is off now: the user's standing opt-in to multi-agent orchestration has ended. Run a workflow only when the task calls for one or the user asks.",
};
