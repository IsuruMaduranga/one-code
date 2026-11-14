/**
 * User message display (pure). Claude Code shows each user prompt as
 * `❯ text`. pi draws a user message through its own Markdown component and
 * exposes only a text-level transformer for it, so the marker rides as a
 * `❯ ` prefix on the first line, like the assistant's `●`
 * (`assistant-marker.ts`).
 *
 * pi runs the transformers in extension load order and lets each extension
 * register one, so every rewrite of a user message lives in this one
 * function, in the order it must happen: a harness notification that opened
 * a turn becomes its headline (no marker: the user did not type it); a typed
 * command's breadcrumb becomes the command line; then the marker goes on.
 * A transformer elsewhere that rewrote the text after the marker was added
 * would see `❯ <command-message>…` and miss it.
 *
 * Display only: the transform runs inside pi's component at render time, so
 * the stored entry and every request keep the text the user sent.
 */
import { commandDisplayLine } from "../../lib/plugins/skill-invoke.ts";
import { notificationUserMarkdown } from "../../lib/ui/tui-render.ts";
import { BLOCK_START } from "./assistant-marker.ts";

/** The pointer in front of a user prompt (U+276F). */
export const USER_MARKER = "❯";

/** The slice of pi's theme the painted marker needs. */
interface MarkerTheme {
	fg(color: string, text: string): string;
	getFgAnsi(color: string): string;
}

/**
 * The marker in the theme's `dim` colour. pi draws the message text in
 * `userMessageText` and the marker's colour reset would end it, so that
 * colour opens again after the marker. Plain when the theme is missing.
 */
export function paintedUserMarker(theme: unknown): string {
	const painter = theme as Partial<MarkerTheme> | undefined;
	try {
		if (painter?.fg && painter.getFgAnsi) return `${painter.fg("dim", USER_MARKER)}${painter.getFgAnsi("userMessageText")}`;
	} catch {
		// A theme that cannot paint: the plain marker.
	}
	return USER_MARKER;
}

/**
 * Prefix user `markdown` with `marker` and a space. A first line that opens
 * a Markdown block (a fence, heading, list, quote, table, rule or HTML) would
 * stop being that block with text in front of it (a fence would lose its
 * opening line and swallow the rest of the message), so the marker then sits
 * alone above the message, a blank line apart, and the Markdown is untouched.
 */
export function markUserMarkdown(markdown: string, marker: string = USER_MARKER): string {
	const body = markdown.replace(/^(?:[ \t]*\r?\n)+/, "");
	if (!body) return markdown;
	const newline = body.indexOf("\n");
	const firstLine = newline === -1 ? body : body.slice(0, newline);
	if (BLOCK_START.some((pattern) => pattern.test(firstLine))) return `${marker}\n\n${body}`;
	return `${marker} ${body}`;
}

/**
 * What the transcript shows for a user message: a notification's headline,
 * else the marked command line or text. `marker` is the painted pointer.
 */
export function userMessageMarkdown(markdown: string, marker: string = USER_MARKER): string {
	const notification = notificationUserMarkdown(markdown);
	if (notification !== undefined) return notification;
	return markUserMarkdown(commandDisplayLine(markdown) ?? markdown, marker);
}
