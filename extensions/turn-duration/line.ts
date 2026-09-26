/**
 * Pure pieces of Claude Code's turn-duration line ("✻ Cooked for 5m 12s"),
 * matched to CC's SystemTextMessage/TurnDurationMessage render
 * (`${verb} for ${duration}`, dim, led by the ✻ teardrop asterisk). CC shows
 * it after every response with no minimum-duration threshold; the optional
 * token-budget suffix is CC's separate /budget feature and is not replicated.
 */

import { countNoun, formatDuration } from "../lib/tui-render.ts";

/** CC's TEARDROP_ASTERISK (figures.ts), the mark leading the duration line. */
export const TURN_MARK = "✻";

/**
 * `<Verb> for <duration>` — duration formatted like the spinner's elapsed
 * clock — then Claude Code's ` · done <time>` when the finish time is known,
 * then its background-shell tail (`· 2 shells still running`) when shells
 * outlive the turn.
 */
export function turnDurationText(verb: string, durationMs: number, runningShells = 0, doneAt?: string): string {
	const done = doneAt ? ` · done ${doneAt}` : "";
	const shells = runningShells > 0 ? ` · ${countNoun(runningShells, "shell")} still running` : "";
	return `${verb} for ${formatDuration(0, durationMs)}${done}${shells}`;
}

/**
 * The locale Claude Code formats times in: `LC_ALL`, then `LC_TIME`, then
 * `LANG`, with the encoding and modifier dropped (`en_US.UTF-8` → `en-US`);
 * undefined for `C`, `POSIX`, unset or a tag Intl rejects, which leaves the
 * runtime's default.
 */
export function timeLocale(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.LC_ALL || env.LC_TIME || env.LANG || "";
	if (!raw || raw === "C" || raw === "POSIX") return undefined;
	const tag = raw.split(".")[0]?.split("@")[0]?.replaceAll("_", "-");
	if (!tag) return undefined;
	try {
		new Intl.DateTimeFormat(tag);
		return tag;
	} catch {
		return undefined;
	}
}

const DAY_MS = 86_400_000;

/** Midnight of `date`'s calendar day, in the runtime's local time zone. */
function localDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Claude Code's "done" time (its `auto` time format): the time alone for a
 * turn that finished today (`2:33 PM`), the weekday too within the last week
 * (`Friday 2:33 PM`), and the date as well before that (`Friday, Sep 19, 2:33
 * PM`), in the locale's own hour cycle. Empty for an invalid date.
 */
export function formatDoneAt(at: Date, now: Date = new Date(), locale: string | undefined = timeLocale()): string {
	if (Number.isNaN(at.getTime())) return "";
	const days = Math.round((localDay(now) - localDay(at)) / DAY_MS);
	const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
	const options: Intl.DateTimeFormatOptions =
		days === 0 ? time : days > 0 && days < 7 ? { weekday: "long", ...time } : { weekday: "long", month: "short", day: "numeric", ...time };
	return new Intl.DateTimeFormat(locale, options).format(at);
}
