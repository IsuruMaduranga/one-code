/**
 * OpenRouter hosts One Code asks OpenRouter to skip because they defeat the
 * prompt cache, as a list that is easy to shrink when a host fixes its cache.
 *
 * OpenRouter keeps a session on the host that served its first request
 * (`x-session-id`, which pi-ai sends), so one host that reuses little keeps a
 * whole session or side call on cold reads. Measured on 2026-11-16
 * (working-docs/findings/93-openrouter-hosts-and-the-prompt-cache.md):
 * OpenInference reused a classifier prompt only when it was byte-identical
 * (0 cached tokens on 8 of 8 grown prompts) and read session prompts in
 * 512-token blocks. To take a host off the list, measure it reading a grown
 * prompt's prefix, then delete its entry.
 *
 * Each request on an OpenRouter Chat Completions model carries
 * `provider.ignore` with these slugs (pi-ai sends `compat.openRouterRouting`
 * as the `provider` object). The value depends only on the model and the
 * user's routing, so it is the same on every request of a session and on its
 * side calls, and the prompt prefix stays stable. OpenRouter skips an ignored
 * slug that does not serve the model. The merge never overrides the user's
 * routing: a host the user names in `order` or `only` is not ignored, and an
 * `ignore` list the user set keeps its entries, ours appended.
 *
 * `<envPrefix>_OPENROUTER_IGNORE_HOSTS=0` turns it off. Pure: no pi imports.
 */

import { knobValue } from "../profile/knobs.ts";
import type { CacheMarksModel } from "./openrouter-cache-marks.ts";
import { OPENROUTER_CACHE_MARKS_API, OPENROUTER_PROVIDER } from "./openrouter-cache-marks.ts";

/** A host that defeats the prompt cache: OpenRouter's slug (what `provider.ignore` takes), its display name, and when it was measured. */
export interface IgnoredHost {
	slug: string;
	name: string;
	measured: string;
}

/** The hosts skipped today. */
export const CACHE_DEFEATING_HOSTS: readonly IgnoredHost[] = [{ slug: "open-inference", name: "OpenInference", measured: "2026-11-16" }];

/** The knob that turns the list off (`<envPrefix>_OPENROUTER_IGNORE_HOSTS=0`). */
export const OPENROUTER_IGNORE_HOSTS_KNOB = "OPENROUTER_IGNORE_HOSTS";

/** Whether the list applies in `vars` (the process environment by default). */
export function openRouterIgnoreHostsEnabled(vars: Readonly<Record<string, unknown>> = process.env): boolean {
	return knobValue(OPENROUTER_IGNORE_HOSTS_KNOB, vars) !== "0";
}

type Routing = Record<string, unknown>;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

/** Whether a routing entry names `host`: its slug or display name, with or without a variant (`open-inference/fp4`), in any case. */
function names(entry: string, host: IgnoredHost): boolean {
	const base = entry.trim().toLowerCase().split("/")[0];
	return base === host.slug || base === host.name.toLowerCase();
}

/**
 * The user's OpenRouter routing with `hosts` added to its `ignore` list:
 * a host the routing already names in `order`, `only` or `ignore` is left out.
 * Returns `routing` itself when nothing is added.
 */
export function withIgnoredHosts(routing: Routing | undefined, hosts: readonly IgnoredHost[] = CACHE_DEFEATING_HOSTS): Routing | undefined {
	const named = [...strings(routing?.order), ...strings(routing?.only), ...strings(routing?.ignore)];
	const added = hosts.filter((host) => !named.some((entry) => names(entry, host))).map((host) => host.slug);
	if (added.length === 0) return routing;
	return { ...routing, ignore: [...(Array.isArray(routing?.ignore) ? (routing.ignore as unknown[]) : []), ...added] };
}

/** `model` with the hosts skipped, as a copy; the model itself when it is not an OpenRouter Chat Completions model or nothing changes. */
export function withOpenRouterIgnoredHosts<M extends CacheMarksModel>(model: M): M {
	if (model.provider !== OPENROUTER_PROVIDER || model.api !== OPENROUTER_CACHE_MARKS_API) return model;
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	const routing = compat.openRouterRouting as Routing | undefined;
	const next = withIgnoredHosts(routing);
	if (next === routing) return model;
	return { ...model, compat: { ...compat, openRouterRouting: next } };
}
