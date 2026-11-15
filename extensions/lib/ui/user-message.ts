/**
 * How the transcript shows a user message (pure): the one ordered pipeline of
 * display rewrites, which the user-message extension (ui/user-message)
 * registers as its Markdown transformer.
 *
 * pi draws a user message through its own Markdown component and exposes
 * only a text-level transformer for it. pi runs the transformers in extension
 * load order and lets each extension register one, so every rewrite of a
 * user message lives in this one function, in the order it must happen: a
 * harness notification that opened a turn becomes its headline (no marker:
 * the user did not type it); a typed command's breadcrumb becomes the command
 * line; then, when the branding feature is on, Claude Code's `❯` pointer goes
 * on as a prefix of the first line, like the assistant's `●`
 * (ui/branding/assistant-marker.ts). A transformer elsewhere that rewrote the
 * text after the marker was added would see `❯ <command-message>…` and miss it.
 *
 * Display only: the transform runs inside pi's component at render time, so
 * the stored entry and every request keep the text the user sent.
 */
import { brandedId } from "../profile/brand.mjs";
import { commandDisplayLine } from "../plugins/skill-invoke.ts";
import { opensMarkdownBlock } from "./markdown-blocks.ts";
import { notificationUserMarkdown } from "./tui-render.ts";

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
 * a Markdown block (a fence, heading, list, quote, table, rule or HTML, after
 * up to three spaces of indentation, or an indented code block) would stop
 * being that block with text in front of it (a fence would lose its opening
 * line and swallow the rest of the message), so the marker then sits alone
 * above the message, a blank line apart, and the Markdown, its indentation
 * included, is untouched.
 */
export function markUserMarkdown(markdown: string, marker: string = USER_MARKER): string {
	const body = markdown.replace(/^(?:[ \t]*\r?\n)+/, "");
	if (!body) return markdown;
	const newline = body.indexOf("\n");
	const firstLine = newline === -1 ? body : body.slice(0, newline);
	if (opensMarkdownBlock(firstLine)) return `${marker}\n\n${body}`;
	return `${marker} ${body}`;
}

/**
 * What the transcript shows for a user message: a notification's headline,
 * else the command line or text, marked with `marker` (the painted pointer)
 * when one is given.
 */
export function userMessageMarkdown(markdown: string, marker?: string): string {
	const notification = notificationUserMarkdown(markdown);
	if (notification !== undefined) return notification;
	const shown = commandDisplayLine(markdown) ?? markdown;
	return marker === undefined ? shown : markUserMarkdown(shown, marker);
}

/**
 * Asks the user-message extension for its display rewrite, so a row another
 * extension draws as a user message (a skill typed after the first turn,
 * tools/skill) shows what a user message with the same text shows: the
 * command line, with the pointer while branding is on. The extension sets
 * `transform`.
 */
export const USER_MARKDOWN_CHANNEL = brandedId("user-markdown");
export interface UserMarkdownQuery {
	transform?: (markdown: string) => string;
}

/**
 * The rewrite a user row's text goes through: the owner's answer, else this
 * pipeline with no pointer (the extension not loaded, as in a bare test
 * harness). Display only.
 */
export function userRowTransform(query: UserMarkdownQuery): (markdown: string) => string {
	return query.transform ?? ((markdown) => userMessageMarkdown(markdown));
}
