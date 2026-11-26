/**
 * cache-marks extension — keeps the previous request's conversation breakpoint
 * on an Anthropic request, so a request that adds many blocks at once still
 * reads the cache the previous one wrote (request/cache-marks/previous-mark.ts has the why).
 *
 * The previous breakpoint comes from the ledger's plan, not from memory: inside
 * an epoch the request extends a recorded base, and the base carried its tail
 * mark on the last block before its trailing directive. So a resume, /reload,
 * /tree and a pi cache warm mark the same block the base did.
 *
 * Load order: after the ledger's payload hook (extensions/request/ledger/wire.ts), the
 * last extension that edits the messages. First-party Anthropic only: the
 * Messages API is where the look-back was measured, and its four-breakpoint
 * limit is checked here.
 *
 * It also registers the `openrouter` provider's Chat Completions stream with
 * pi's own breakpoints turned on for the measured open-weight vendors, some of
 * whose hosts cache nothing without them (lib/request/openrouter-cache-marks.ts),
 * and with the hosts that defeat the prompt cache skipped on the models of
 * their measured vendors
 * (lib/request/openrouter-ignored-hosts.ts), and with the routing defaults the
 * profile declares per vendor (lib/request/openrouter-routing-defaults.ts).
 * `*_CACHE_MARKS=0` turns all marks off, to compare a run with and without
 * them; `*_OPENROUTER_CACHE_MARKS=0` turns off only the OpenRouter ones;
 * `*_OPENROUTER_IGNORE_HOSTS=1` skips the measured hosts in the session too (side calls
 * skip them by default, lib/request/openrouter-ignored-hosts.ts; `=0` turns that off);
 * `*_OPENROUTER_ROUTING_DEFAULTS=0` turns off the profile's routing defaults.
 */

import { knobValue } from "../../lib/profile/knobs.ts";
import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { looksLikeAnthropicRequest } from "../../lib/request/anthropic-payload.ts";
import { isFirstPartyAnthropic } from "../../lib/request/anthropic-server-tools.ts";
import { openRouterRegistration } from "../../lib/request/anthropic-stream.ts";
import { CACHE_MARKS_KNOB, openRouterCacheMarksEnabled } from "../../lib/request/openrouter-cache-marks.ts";
import { openRouterIgnoreHostsEnabled } from "../../lib/request/openrouter-ignored-hosts.ts";
import { activeOpenRouterRouting } from "../../lib/request/openrouter-routing-defaults.ts";
import { adjustsOpenRouter, type OpenRouterAdjustOptions, openRouterAdjust } from "./openrouter-adjust.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../../lib/request/ledger/plan.ts";
import { baseMark, withPreviousMark } from "./previous-mark.ts";

function cacheMarksExtension(pi: ExtensionAPI) {
	const options: OpenRouterAdjustOptions = {
		marks: openRouterCacheMarksEnabled(),
		ignore: openRouterIgnoreHostsEnabled(),
		routing: activeOpenRouterRouting(),
	};
	if (adjustsOpenRouter(options)) {
		const openRouter = openRouterRegistration(openRouterAdjust(options));
		if (openRouter) pi.registerProvider("openrouter", openRouter);
	}
	if (knobValue(CACHE_MARKS_KNOB) === "0") return;
	/** The plan of the request being sent; a warm reuses it. */
	let plan: RequestPlan | undefined;
	pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
		plan = data as RequestPlan;
	});
	pi.on("session_start", () => {
		plan = undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown>;
		if (!ctx.model || !isFirstPartyAnthropic(ctx.model) || !looksLikeAnthropicRequest(payload)) return undefined;
		const base = plan && !plan.epoch ? plan.base : undefined;
		const next = withPreviousMark(payload, base ? baseMark(payload.messages, base.list, ctx.model.api) : undefined);
		return next === payload ? undefined : next;
	});
}

export default feature("cache-marks", cacheMarksExtension);
