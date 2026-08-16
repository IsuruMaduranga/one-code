/**
 * Pure pieces of Claude Code's turn-duration line ("✻ Cooked for 5m 12s"),
 * matched to CC's SystemTextMessage/TurnDurationMessage render
 * (`${verb} for ${duration}`, dim, led by the ✻ teardrop asterisk). CC shows
 * it after every response with no minimum-duration threshold; the optional
 * token-budget suffix is CC's separate /budget feature and is not replicated.
 */

import { formatDuration } from "../lib/tui-render.ts";

/** CC's TEARDROP_ASTERISK (figures.ts), the mark leading the duration line. */
export const TURN_MARK = "✻";

/** `<Verb> for <duration>` — duration formatted like the spinner's elapsed clock. */
export function turnDurationText(verb: string, durationMs: number): string {
	return `${verb} for ${formatDuration(0, durationMs)}`;
}
