/**
 * cache-marks extension — keeps the previous request's conversation breakpoint
 * on an Anthropic request, so a request that adds many blocks at once still
 * reads the cache the previous one wrote (lib/previous-mark.ts has the why).
 *
 * Load order: after tool-search, the last extension that edits the messages
 * (it lifts tool additions and moves the tail breakpoint), and before
 * compaction, whose payload hook captures the request the side calls replay.
 * First-party Anthropic only: the Messages API is where the look-back was
 * measured, and its four-breakpoint limit is checked here. `CC_CACHE_MARKS=0`
 * turns it off, to compare a run with and without the mark.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { looksLikeAnthropicRequest } from "../lib/anthropic-payload.ts";
import { isFirstPartyAnthropic } from "../lib/anthropic-server-tools.ts";
import { lastMessageMark, type MessageMark, withPreviousMark } from "../lib/previous-mark.ts";

export default function cacheMarksExtension(pi: ExtensionAPI) {
	if (process.env.CC_CACHE_MARKS === "0") return;
	/** The last breakpoint the previous request sent; reset where the conversation is rebuilt. */
	let previous: MessageMark | undefined;
	const forget = () => {
		previous = undefined;
	};
	pi.on("session_start", forget);
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown>;
		if (!ctx.model || !isFirstPartyAnthropic(ctx.model) || !looksLikeAnthropicRequest(payload)) return undefined;
		const next = withPreviousMark(payload, previous);
		previous = lastMessageMark(next.messages);
		return next === payload ? undefined : next;
	});
}
