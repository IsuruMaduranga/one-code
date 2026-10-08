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

export type AnnouncementPlan =
	| { kind: "none" }
	/** Nothing is cached yet: (re)write the standing listing with every name. */
	| { kind: "rewrite"; names: string[] }
	/** Message 1 is frozen: announce only the new names as a one-shot. */
	| { kind: "addendum"; added: string[] };

export function planAnnouncement(input: {
	requestSent: boolean;
	announced: ReadonlySet<string>;
	available: readonly string[];
}): AnnouncementPlan {
	if (!input.requestSent) {
		return input.available.length === 0 ? { kind: "none" } : { kind: "rewrite", names: [...input.available] };
	}
	const added = input.available.filter((name) => !input.announced.has(name));
	return added.length === 0 ? { kind: "none" } : { kind: "addendum", added };
}

/** JSON-safe persisted baseline for the names already described to the model. */
export function deferredToolsBaseline(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return undefined;
	return [...new Set(value)];
}

/** Compatibility fallback for a v1 stack written before structured baselines. */
export function deferredToolsFromReminder(text: string | undefined): string[] | undefined {
	if (!text) return undefined;
	const marker = "\n";
	const lines = text.split(marker);
	return lines.length > 1 && lines[0].startsWith("The following deferred tools are available via tool_search")
		? lines.slice(1).filter(Boolean)
		: undefined;
}

/** Bring the announced set in line with what the plan told the model. */
export function applyAnnouncement(announced: Set<string>, plan: AnnouncementPlan): void {
	if (plan.kind === "rewrite") {
		announced.clear();
		for (const name of plan.names) announced.add(name);
	} else if (plan.kind === "addendum") {
		for (const name of plan.added) announced.add(name);
	}
}
