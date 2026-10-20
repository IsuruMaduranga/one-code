/**
 * What to tell the model when the deferred-tool set changes (pure).
 *
 * The deferred-tools listing is a `first-prepend` reminder on message 1, so it
 * is part of the cached prefix of every later request. Before the first request
 * nothing is cached and the listing can be rewritten freely; after it, any
 * rewrite re-caches the whole conversation (measured 2026-09-04: 16.7k tokens
 * re-written on request 2 of a run whose MCP tools registered inside the
 * announce debounce). So once a request has gone out the listing is FROZEN and
 * later arrivals ride a one-shot addendum where the model reads next. Names that
 * disappear are not announced: the frozen listing keeps them and `tool_search`
 * reports "not found" if the model asks for one.
 */

export { applyAnnouncement, type AnnouncementPlan, namesBaseline as deferredToolsBaseline, planAnnouncement } from "../lib/announced-names.ts";

/** Compatibility fallback for a v1 stack written before structured baselines. */
export function deferredToolsFromReminder(text: string | undefined): string[] | undefined {
	if (!text) return undefined;
	const marker = "\n";
	const lines = text.split(marker);
	return lines.length > 1 && lines[0].startsWith("The following deferred tools are available via tool_search")
		? lines.slice(1).filter(Boolean)
		: undefined;
}
