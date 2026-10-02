/**
 * kept-thinking extension — removes thinking from the turns a compaction keeps,
 * on APIs that check a thinking block's signature against the conversation
 * before it (`compaction/kept-thinking.ts` says why and which turns).
 *
 * The boundary comes from the session branch, not from the request's messages:
 * system-reminder rewrites the compaction summary message into a plain user
 * message, so a strip keyed on it found nothing (seen live on Opus 5.5: every
 * request after the compaction was a 400). It is the first `context` hook in
 * the package manifest, before every extension that captures the request's
 * messages for a side call (skill, background, subagents, recap, btw,
 * compaction), so each capture carries the stripped history the session sent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { signsThinking, withoutKeptThinking } from "../compaction/kept-thinking.ts";
import { latestCompaction } from "../lib/compaction-boundary.ts";

export default function keptThinkingExtension(pi: ExtensionAPI) {
	pi.on("context", (event, ctx) => {
		const api = ctx.model?.api;
		// Only a signing API pays for the branch walk.
		if (!signsThinking(api)) return undefined;
		const messages = withoutKeptThinking(event.messages, api, latestCompaction(ctx.sessionManager.getBranch())?.time);
		return messages ? { messages } : undefined;
	});
}
