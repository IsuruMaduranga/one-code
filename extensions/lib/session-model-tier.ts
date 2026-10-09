/**
 * One request-surface tier per session/model boundary. The first consumer owns
 * the lifecycle handlers; every consumer reads that owner's value over the
 * event bus. No module state is shared (each extension has its own jiti copy),
 * and an extension loaded in isolation still installs its own owner.
 *
 * Only session_start and model_select classify. A catalog refresh can affect
 * automatic model selection immediately, but prompt text, tool descriptions,
 * and tier-dependent steering keep the same tier until the next boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type PromptTier, resolveModelTier } from "./model-tier.ts";
import { invalidateCatalogCache } from "./model-catalog-data.ts";

const SESSION_TIER_REQUEST_CHANNEL = "one-code:session-tier-request";

interface TierRequest {
	owned?: boolean;
	tier?: PromptTier;
}

/** Install the owner once on this bus, and return a reader of its frozen tier. */
export function sessionModelTier(pi: Pick<ExtensionAPI, "events" | "on">): () => PromptTier {
	const request = (): TierRequest => {
		const query: TierRequest = {};
		pi.events.emit(SESSION_TIER_REQUEST_CHANNEL, query);
		return query;
	};
	if (!request().owned) {
		let tier: PromptTier | undefined;
		pi.events.on(SESSION_TIER_REQUEST_CHANNEL, (data) => {
			Object.assign(data as TierRequest, { owned: true, tier });
		});
		const resolve = (model: Parameters<typeof resolveModelTier>[0]) => {
			// Doctor's jiti copy cannot clear our memo. Do not freeze a stale
			// catalog if the boundary lands inside the disk cache's stat throttle.
			invalidateCatalogCache();
			tier = resolveModelTier(model);
		};
		// Registered before the first consumer's hooks. Later consumers preserve
		// their own lifecycle ordering (for example, restored bash mode variants).
		pi.on("session_start", (_event, ctx) => resolve(ctx.model));
		pi.on("model_select", (event) => resolve(event.model));
	}
	return () => {
		const tier = request().tier;
		if (tier === undefined) throw new Error("Request tier is unavailable: emit session_start before building the request surface.");
		return tier;
	};
}
