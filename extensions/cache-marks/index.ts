/**
 * cache-marks extension — keeps the previous request's conversation breakpoint
 * on an Anthropic request, so a request that adds many blocks at once still
 * reads the cache the previous one wrote (lib/previous-mark.ts has the why).
 *
 * The previous breakpoint comes from the ledger's plan, not from memory: inside
 * an epoch the request extends a recorded base, and the base carried its tail
 * mark on the last block before its trailing directive. So a resume, /reload,
 * /tree and a pi cache warm mark the same block the base did.
 *
 * Load order: after the ledger's payload hook (extensions/ledger/wire.ts), the
 * last extension that edits the messages. First-party Anthropic only: the
 * Messages API is where the look-back was measured, and its four-breakpoint
 * limit is checked here. `CC_CACHE_MARKS=0` turns it off, to compare a run with
 * and without the mark.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { looksLikeAnthropicRequest } from "../lib/anthropic-payload.ts";
import { isFirstPartyAnthropic } from "../lib/anthropic-server-tools.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../lib/ledger/plan.ts";
import { baseMark, withPreviousMark } from "../lib/previous-mark.ts";

export default function cacheMarksExtension(pi: ExtensionAPI) {
	if (process.env.CC_CACHE_MARKS === "0") return;
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
