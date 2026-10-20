/**
 * A frozen listing of names and the names announced after it (pure). Shared by
 * the deferred-tools listing (tool-search) and the skills listing (skill): before
 * the first request the standing listing is (re)written with every name; once a
 * request has gone out it is part of the cached prefix, so only names that
 * became available since ride a one-shot. Names that disappear are not
 * announced (decisions/caching.md "Message 1 is frozen after the first request").
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
export function namesBaseline(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return undefined;
	return [...new Set(value)];
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
