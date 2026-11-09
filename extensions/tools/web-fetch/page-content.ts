import type { WebFetchText } from "./text.ts";

/** The profile's words around a fetched page (text.ts `page`). */
export type PageWords = WebFetchText["page"];

/** The title is page content too; include it when applying a reader's input limit. */
export function pageText(words: PageWords, text: string, title?: string): string {
	return [title ? words.title(title) : undefined, text].filter((part) => part !== undefined).join("\n\n");
}

/** Stable framing for fetched text, shared by the reader prompt and model-facing results. */
export function pageContent(words: PageWords, text: string, title?: string): string {
	const content = pageText(words, text, title);
	// A page (including its title) cannot close its own data boundary. Keep the
	// framing deterministic so identical reader calls retain their cache prefix.
	const escaped = content.replace(/<\/?page\b/gi, (tag) => tag.replace("<", "&lt;"));
	return [words.before, "<page>", escaped, "</page>", words.after].join("\n");
}
