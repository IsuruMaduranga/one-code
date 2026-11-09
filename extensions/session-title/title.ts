/**
 * Session title — the pure half of the session-title extension.
 *
 * Claude Code names a session with one small-model call (`generate_session_title`,
 * Haiku 4.5; `captures/session_name.json`, CC 2.1.278, findings §14): the
 * naming instruction as the system prompt, the first user prose wrapped in
 * `<session>` tags plus a one-line language note as the user message, no
 * tools, thinking off, a `{ "title": string }` JSON-schema output. The
 * strings are that capture verbatim, in the profile (text.ts); the parser is
 * lenient because pi's
 * `completeSimple` has no structured-output option and not every provider
 * honours one — a model that answers with prose or a fenced block still names
 * the session.
 */

import { LOCAL_COMMAND_TAG_PREFIXES } from "../lib/ui/local-command.ts";
import { customMessageText } from "../lib/ui/tui-render.ts";
import { sanitizeTitle } from "../lib/ui/terminal-text.ts";
import type { SessionTitleText } from "./text.ts";

/** CC's `MAX_CONVERSATION_TEXT`: the tail of the first message that is sent (recent context wins). */
export const SESSION_TEXT_LIMIT = 1000;

/** The user message of the naming request: the session text's tail, in the profile's frame. */
export function sessionTitleInput(words: SessionTitleText, text: string): string {
	const trimmed = text.trim();
	return words.user(trimmed.length > SESSION_TEXT_LIMIT ? trimmed.slice(-SESSION_TEXT_LIMIT) : trimmed);
}

/**
 * Prefixes of a first message that is not the user's topic: CC's REPL skips
 * these before naming (slash-command breadcrumbs, skill expansions, bash-mode
 * input) and waits for real prose. In One Code the breadcrumbs ride the request
 * (never the stored message), so of these only a slash command that reached
 * the model as text is reachable; the tag list is kept for a transcript that
 * did carry them (a CC session file, a future persisted form).
 */
const NOT_A_TOPIC_PREFIXES = [...LOCAL_COMMAND_TAG_PREFIXES, "<bash-input>"];

/** True when `text` is prose worth naming the session after. */
export function isNameableText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	// A slash command that reached the model as text is not a topic either.
	if (trimmed.startsWith("/")) return false;
	return !NOT_A_TOPIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Titles longer than this are a paragraph, not a name — the parse failed. */
const MAX_TITLE_LENGTH = 120;

/**
 * The title out of the model's reply. Accepts CC's `{"title": "…"}` (also
 * inside a fenced block or after prose), and, when there is no JSON at all, a
 * single short line. Returns undefined when nothing title-like is there.
 */
export function parseTitle(reply: string): string | undefined {
	const text = reply.trim();
	if (!text) return undefined;
	const fromJson = titleFromJson(text);
	if (fromJson !== undefined) return fromJson;
	if (text.includes("{")) return undefined; // JSON was attempted and is unusable
	const lines = text.split("\n").filter((line) => line.trim());
	if (lines.length !== 1) return undefined;
	return normalizeTitle(lines[0].replace(/^["'`]+|["'`]+$/g, ""));
}

function titleFromJson(text: string): string | undefined {
	// The outermost object: from the first "{" to the last "}" (a fence or a
	// lead-in sentence around it does not matter).
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { title?: unknown };
		return typeof parsed?.title === "string" ? normalizeTitle(parsed.title) : undefined;
	} catch {
		return undefined;
	}
}

function normalizeTitle(raw: string): string | undefined {
	// The title becomes the terminal title inside pi's own OSC 0: an embedded
	// BEL or ESC would end that sequence and run the rest as terminal output.
	const title = sanitizeTitle(raw);
	if (!title || title.length > MAX_TITLE_LENGTH) return undefined;
	// CC: "Capitalize the first letter of the title."
	return title[0].toUpperCase() + title.slice(1);
}

interface EntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

/**
 * The text of the first user message in the session's entries — CC names the
 * session after the FIRST non-meta user message, so a resumed unnamed session
 * is named after how it began, not after the prompt that resumed it.
 */
export function firstUserText(entries: readonly EntryLike[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		return customMessageText(entry.message.content);
	}
	return undefined;
}
