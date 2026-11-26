/**
 * OpenRouter hosts measured defeating the prompt cache, which OpenRouter is
 * asked to skip. By default only side calls with their own OpenRouter session
 * skip them (the classifier, the reader, /btw, recap, the session title,
 * setup: `withSideCallIgnoredHosts`): nothing names a host to the user for
 * those, and a side call's cache miss is never an accepted cost. The main
 * session leaves no host out unless the user asks, and a host that keeps
 * missing its cache is named to them at run time instead
 * (openrouter-cache-watch.ts). Compaction and the replayed forks send under
 * the main session's id, so they stay on its host.
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
 * A model whose only host is ignored fails every request ("All providers have
 * been ignored"), which is worse than a cache miss. So each host is skipped
 * only on the model-id vendors it was measured for: vendors where the host was
 * seen defeating the cache AND every catalog model of that vendor it serves
 * has at least one other host that caches (OpenRouter's endpoints API lists
 * the hosts and their `input_cache_read` price). A vendor where one of its
 * models has no other host would be scoped by exact model id instead. To widen
 * a scope, measure the host on the new vendor's models, check each of those
 * models has another caching host, then add the vendor.
 *
 * Each request on an OpenRouter Chat Completions model in a host's scope
 * carries `provider.ignore` with its slug (pi-ai sends `compat.openRouterRouting`
 * as the `provider` object). The value depends only on the model and the
 * user's routing, so it is the same on every request of a session and on its
 * side calls, and the prompt prefix stays stable. OpenRouter skips an ignored
 * slug that does not serve the model. The merge never overrides the user's
 * routing: a host the user names in `order` or `only` is not ignored, and an
 * `ignore` list the user set keeps its entries, ours appended.
 *
 * `<envPrefix>_OPENROUTER_IGNORE_HOSTS=1` turns it on for the main session too, `=0`
 * turns it off everywhere. Pure: no pi imports.
 */

import { knobValue } from "../profile/knobs.ts";
import type { CacheMarksModel } from "./openrouter-cache-marks.ts";
import { modelVendor, type OpenRouterRouting, routingEntries, routingEntryHost, withOpenRouterRouting } from "./openrouter-cache-marks.ts";

/**
 * A host that defeats the prompt cache: OpenRouter's slug (what
 * `provider.ignore` takes), its display name, when it was measured, and the
 * model-id vendors (the part before the slash, without a leading `~`) it is
 * skipped on.
 */
export interface IgnoredHost {
	slug: string;
	name: string;
	measured: string;
	vendors: readonly string[];
}

/**
 * The hosts skipped when the list is on. OpenInference: measured on
 * deepseek/deepseek-v4.1-flash-1017. Of the catalog's OpenRouter models it
 * serves deepseek-v4.1-flash (36 other hosts, each with a cache-read price),
 * deepseek-v4.1-flash-1017 (47) and z-ai/glm-5.3-flash (41), checked on
 * 2026-11-16; GLM is left out until the host is measured there.
 */
export const CACHE_DEFEATING_HOSTS: readonly IgnoredHost[] = [{ slug: "open-inference", name: "OpenInference", measured: "2026-11-16", vendors: ["deepseek"] }];

/** The hosts whose scope holds `modelId`'s vendor. */
export function hostsFor(modelId: string, hosts: readonly IgnoredHost[] = CACHE_DEFEATING_HOSTS): IgnoredHost[] {
	const vendor = modelVendor(modelId);
	return hosts.filter((host) => host.vendors.includes(vendor));
}

/** The knob for the list: `=1` adds the main session, `=0` turns it off for side calls too. */
export const OPENROUTER_IGNORE_HOSTS_KNOB = "OPENROUTER_IGNORE_HOSTS";

/** Whether the main session's requests skip the hosts in `vars` (the process environment by default): only when the user turned it on. */
export function openRouterIgnoreHostsEnabled(vars: Readonly<Record<string, unknown>> = process.env): boolean {
	return knobValue(OPENROUTER_IGNORE_HOSTS_KNOB, vars) === "1";
}

/** Whether a routing entry names `host`: its slug or display name, with or without a variant (`open-inference/fp4`), in any case. */
function names(entry: string, host: IgnoredHost): boolean {
	const base = routingEntryHost(entry);
	return base === host.slug || base === host.name.toLowerCase();
}

/**
 * The user's OpenRouter routing with `hosts` added to its `ignore` list:
 * a host the routing already names in `order`, `only` or `ignore` is left out.
 * Returns `routing` itself when nothing is added.
 */
export function withIgnoredHosts(routing: OpenRouterRouting | undefined, hosts: readonly IgnoredHost[] = CACHE_DEFEATING_HOSTS): OpenRouterRouting | undefined {
	const named = [...routingEntries(routing?.order), ...routingEntries(routing?.only), ...routingEntries(routing?.ignore)];
	const added = hosts.filter((host) => !named.some((entry) => names(entry, host))).map((host) => host.slug);
	if (added.length === 0) return routing;
	return { ...routing, ignore: [...(Array.isArray(routing?.ignore) ? (routing.ignore as unknown[]) : []), ...added] };
}

/** `model` with the hosts in its vendor's scope skipped, as a copy; the model itself when it is not an OpenRouter Chat Completions model, no host's scope holds it, or nothing changes. */
export function withOpenRouterIgnoredHosts<M extends CacheMarksModel>(model: M): M {
	return withOpenRouterRouting(model, (routing) => {
		const hosts = hostsFor(model.id);
		return hosts.length === 0 ? routing : withIgnoredHosts(routing, hosts);
	});
}

/**
 * `model` as a side call with its own OpenRouter session sends it: the hosts
 * in its vendor's scope skipped, unless the user turned the list off
 * (`<envPrefix>_OPENROUTER_IGNORE_HOSTS=0`).
 */
export function withSideCallIgnoredHosts<M extends CacheMarksModel>(model: M, vars: Readonly<Record<string, unknown>> = process.env): M {
	return knobValue(OPENROUTER_IGNORE_HOSTS_KNOB, vars) === "0" ? model : withOpenRouterIgnoredHosts(model);
}
