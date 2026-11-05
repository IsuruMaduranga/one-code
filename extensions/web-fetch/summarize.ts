/**
 * Choosing and prompting the web_fetch reader model (pure).
 *
 * Claude Code's WebFetch answers a `prompt` against the page with a small fast
 * model; this is that selection. The reader reuses the *classifier* role
 * profile: summarisation wants the same small-but-capable floor (mini/haiku/
 * flash), and inventing a third curated inventory would drift from the one
 * already reviewed. Containment is the same rule as everywhere else — the page
 * content and the query go to the model, so automatic selection never leaves
 * the session's provider/family, and no candidate may cost more per token than
 * the session model. With no vetted smaller model the session model reads the
 * page itself: still a win, because the full page stays out of the main
 * conversation.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { type EconomicalModelChoice, pickEconomicalContainedModel } from "../lib/model-tier.ts";
import { pageContent, pageText } from "./page-content.ts";
import type { WebFetchText } from "./text.ts";

/**
 * How much of the page the reader sees. Far past the 30k-char window the main
 * model gets — that gap is the point — but clipped at Claude Code's 100k-char
 * reader limit, with room for the answer.
 */
export const READER_MAX_CHARS = 100_000;

/** Answer budget: WebFetch answers are extracts, not essays. */
export const READER_MAX_TOKENS = 4_000;

export type ReaderChoice = EconomicalModelChoice;

/** The model that reads the page — the shared economical same-containment pick. */
export function pickReaderModel(
	available: Model<Api>[],
	sessionModel: Model<Api> | undefined,
): ReaderChoice | undefined {
	return pickEconomicalContainedModel(available, sessionModel);
}

export interface ReaderMessages {
	system: string;
	user: string;
	/** Whether the page had to be cut to fit the reader. */
	truncated: boolean;
}

/**
 * The reader's request: the page rides in the user message as data, framed
 * (page-content.ts) and cut to the reader's limit, in the profile's words.
 */
export function readerMessages(
	words: Pick<WebFetchText, "page" | "reader">,
	input: {
		prompt: string;
		markdown: string;
		url: string;
		title?: string;
	},
): ReaderMessages {
	const content = pageText(words.page, input.markdown, input.title);
	const truncated = content.length > READER_MAX_CHARS;
	const page = truncated ? content.slice(0, READER_MAX_CHARS) : content;
	const user = words.reader.user({ url: input.url, cutAt: truncated ? READER_MAX_CHARS : undefined, page: pageContent(words.page, page), question: input.prompt });
	return { system: words.reader.system, user, truncated };
}
