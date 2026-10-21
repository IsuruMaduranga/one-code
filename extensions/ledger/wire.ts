/**
 * ledger-wire extension, the payload side of the ledger (extensions/ledger/index.ts
 * has the request side and the design). Its `before_provider_request` hook
 * runs after every hook that shapes the tail (system-reminder's layout,
 * tool-search, context-management) and before cache-marks:
 *
 * 1. Inside an epoch it splices: the base request's recorded list, then pi's
 *    rendering of the tail, under the recorded system prompt and tools, with
 *    tools added mid-epoch appended (lib/ledger/wire.ts spliceRequest).
 * 2. It settles the layout (lib/ledger/layout.ts: no system message stranded
 *    before a user message) and validates the request (lib/ledger/validate.ts): no reference to an
 *    undeclared tool, no system message stranded before a user message. A
 *    problem is a bug; it is dropped and reported, so it costs one block,
 *    never a 400. ONE_CODE_LEDGER_STRICT=1 sends it unrepaired instead, for
 *    the live probes to see.
 * 3. It records the request as a delta against the fold's base (the request
 *    the fold rebuilds it on), with the pending items it carried and what its
 *    new blocks told the model, and publishes it (LEDGER_SENT_CHANNEL) for
 *    the side calls that replay it (compaction's summarizer, btw, recap,
 *    forks).
 *
 * A pi cache warm never records or publishes: it is not a request the model
 * answers. pi sends it through the same hooks with the warm cap, under the
 * plan of the request it warms, in a provider call of its own, so it resends
 * that request as it went out (with the warm's cap), or after a `/reload` (no
 * plan here: pi's context is the tail the old instance cut) the branch's last
 * request. Every other payload follows a context pass: pi's retry runs one
 * too, and a second payload in the call a request went out in is pi-ai's
 * strict-tools fallback, a real re-send. The cap alone cannot tell them
 * apart: pi-ai clamps a request's cap to the window's room, down to 1.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionIdentity } from "../lib/anthropic-auth.ts";
import { notifyOrPrint } from "../lib/headless-output.ts";
import { foldSession } from "../lib/ledger/fold-memo.ts";
import { LEDGER_PLAN_CHANNEL, LEDGER_SENT_CHANNEL, type LedgerSent, type RequestPlan } from "../lib/ledger/plan.ts";
import { makeRecord, RECORD, type ToldFact } from "../lib/ledger/records.ts";
import { deliveredAfterRepair, repairRequest, validateRequest } from "../lib/ledger/validate.ts";
import { settlePayload } from "../lib/ledger/layout.ts";
import { appendPoint, encodeRequest, hasWarmCap, listKey, type RecordedRequest, recordedBody, recordedRequest, samePrefix, spliceRequest, type WirePayload, withBranchToolOrder, withRequestFields } from "../lib/ledger/wire.ts";
import { type AffinityModel, affinityHeaders } from "../lib/request-replay.ts";
import { extensionVersion } from "../lib/package-version.ts";

export default function ledgerWireExtension(pi: ExtensionAPI) {
	const by = extensionVersion();
	/** The plan of the last `context` pass; a warm re-runs only this hook and reuses it. */
	let plan: RequestPlan | undefined;
	/**
	 * The provider call the hook runs in: pi resolves a call's headers once
	 * (`prepareRequest`), before its first payload, so `before_provider_headers`
	 * opens each call, a warm's included.
	 */
	let call = 0;
	/** The call a request under `plan` went out in: a payload with the warm cap in a later call is a warm, in the same call pi-ai's re-send. */
	let sentIn: number | undefined;
	/** What this hook recorded under `plan`: the request, and the hashes it stored, so a re-send stores only new bodies. */
	let recorded: { request: RecordedRequest; hashes: Set<string> } | undefined;
	/** The last session request this instance sent, as it left this hook: what a warm resends. */
	let lastSent: WirePayload | undefined;
	/** Problems already reported this session, so a recurring bug is one notice. */
	const reported = new Set<string>();

	pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
		plan = data as RequestPlan;
		sentIn = undefined;
		recorded = undefined;
	});
	pi.on("session_start", () => {
		plan = undefined;
		sentIn = undefined;
		recorded = undefined;
		lastSent = undefined;
		reported.clear();
	});

	/** The session the plan's request is routed for: the one that opened the epoch, recorded with its base. */
	const routingOf = (current: RequestPlan | undefined, own: string) => (current && !current.epoch ? (current.base?.routing ?? own) : own);

	// A /fork's first request extends its parent's record, and the parent's cache
	// lives on the host the parent's session id routed to: a gateway such as
	// OpenRouter picks it by the session-affinity headers, which pi-ai builds
	// from the fork's own id (R3-M22). Not on Codex, where pi-ai sets its
	// session-id header after every hook (findings §75).
	pi.on("before_provider_headers", (event, ctx) => {
		call++;
		const own = ctx.sessionManager.getSessionId();
		const routing = routingOf(plan, own);
		if (routing === own) return;
		Object.assign(event.headers, affinityHeaders(ctx.model as AffinityModel | undefined, routing));
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const identity = sessionIdentity(pi, model);
		if (!model || !identity) return undefined;
		const api = model.api;
		const live = event.payload as WirePayload;
		const current = plan;

		// A cache warm: the request it warms, as sent, under the warm's cap. A
		// payload in the call the request went out in is pi-ai sending it again.
		if ((!current || (sentIn !== undefined && sentIn !== call)) && hasWarmCap(live)) {
			if (lastSent) return withRequestFields(lastSent, live);
			const base = foldSession(ctx.sessionManager, identity).lastRequest;
			return base ? recordedBody(base, live, api) : undefined;
		}
		// No context pass in this instance and not a warm: leave pi's request alone.
		if (!current) return undefined;

		let payload = live;
		const base = current.epoch ? undefined : current.base;
		const end = base ? appendPoint(base.list, api) : 0;
		if (base) payload = spliceRequest(base, payload, api);
		// An epoch renders pi's tools again, in the order the branch first declared them.
		else payload = withBranchToolOrder(payload, current.fold.toolOrder, api);
		const spliced = payload;
		// The final layout pass: no system message stranded before a user message (lib/ledger/layout.ts).
		payload = settlePayload(payload, api, listKey(api), end);
		let delivered: { consumed: string[]; facts: ToldFact[] } = { consumed: current.consumed, facts: current.carried.flatMap((block) => block.facts) };

		const problems = validateRequest(payload, api);
		if (problems.length > 0) {
			const fresh = problems.map((problem) => JSON.stringify(problem)).filter((key) => !reported.has(key));
			for (const key of fresh) reported.add(key);
			if (fresh.length > 0) notifyOrPrint(ctx, `One Code: the request had ${problems.length} problem(s) the ledger ${process.env.ONE_CODE_LEDGER_STRICT === "1" ? "left in place" : "removed"}: ${fresh.join(", ")}`, "warning");
			if (process.env.ONE_CODE_LEDGER_STRICT !== "1") {
				payload = repairRequest(payload, api, problems);
				delivered = deliveredAfterRepair(payload, api, delivered, current.fold.pending, new Set(current.base?.hashes ?? []), current.carried);
			}
		}

		// The recorded prefix is known, unless the layout pass or a repair moved its elements.
		const request = recordedRequest(payload, identity, base && samePrefix(spliced, payload, listKey(api), end) ? { base, end } : undefined);
		lastSent = payload;
		sentIn = call;
		// The same request again under this plan (pi-ai re-sending an identical body) records nothing new.
		if (recorded && encodeRequest(recorded.request, request, { has: () => true }) === undefined) return payload === live ? undefined : payload;
		const known = { has: (hash: string) => current.fold.knownHashes.has(hash) || recorded?.hashes.has(hash) === true };
		const delta = encodeRequest(current.fold.lastRequest, request, known);
		if (delta) {
			if (current.epoch) pi.appendEntry(RECORD.epoch, makeRecord("epoch", by, { cause: current.cause ?? "first" }));
			const routing = routingOf(current, ctx.sessionManager.getSessionId());
			pi.appendEntry(RECORD.request, makeRecord("request", by, { ...delta, covers: current.covers, consumed: delivered.consumed, routing }));
			if (delivered.facts.length > 0) pi.appendEntry(RECORD.told, makeRecord("told", by, { facts: delivered.facts }));
			recorded = { request, hashes: new Set([...(recorded?.hashes ?? []), ...Object.keys(delta.blobs)]) };
			pi.events.emit(LEDGER_SENT_CHANNEL, { payload, model, sessionId: ctx.sessionManager.getSessionId(), plan: current } satisfies LedgerSent);
		}
		return payload === live ? undefined : payload;
	});
}
