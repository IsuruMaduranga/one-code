/**
 * The model adjustment the `openrouter` provider registration applies to every
 * OpenRouter Chat Completions request (session, children and side calls): the
 * cache marks, the skipped hosts, then the profile's routing defaults, each
 * behind its own switch. Pure: the switches and the table come in as values,
 * so one process builds the same request fields for a model on every call.
 */

import type { CacheMarksModel } from "../../lib/request/openrouter-cache-marks.ts";
import { withOpenRouterCacheMarks } from "../../lib/request/openrouter-cache-marks.ts";
import { withOpenRouterIgnoredHosts } from "../../lib/request/openrouter-ignored-hosts.ts";
import type { OpenRouterRoutingDefault } from "../../lib/profile/openrouter-routing.ts";
import { withOpenRouterRoutingDefaults } from "../../lib/request/openrouter-routing-defaults.ts";

export interface OpenRouterAdjustOptions {
	marks: boolean;
	ignore: boolean;
	/** The profile's routing defaults by vendor; empty when they are off. */
	routing: ReadonlyMap<string, OpenRouterRoutingDefault>;
}

/** Whether the registration has anything to do. */
export function adjustsOpenRouter(options: OpenRouterAdjustOptions): boolean {
	return options.marks || options.ignore || options.routing.size > 0;
}

/** The adjustment for `options`; returns the model itself when nothing applies. */
export function openRouterAdjust<M extends CacheMarksModel>({ marks, ignore, routing }: OpenRouterAdjustOptions): (model: M) => M {
	return (model) => {
		const marked = marks ? withOpenRouterCacheMarks(model) : model;
		const skipped = ignore ? withOpenRouterIgnoredHosts(marked) : marked;
		return withOpenRouterRoutingDefaults(skipped, routing);
	};
}
