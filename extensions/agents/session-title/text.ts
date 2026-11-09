/**
 * What session naming needs from a profile (types only): the small-model
 * call's system prompt and its user message around the session's first text
 * (working-docs/features/profiles/). The base picks the text and clips it.
 */

export interface SessionTitleText {
	/** The naming instruction; it must ask for `{"title": "…"}` JSON (title.ts parseTitle reads it, leniently). */
	system: string;
	/** The user message around the session text, already trimmed and clipped to its tail. */
	user(sessionText: string): string;
}
