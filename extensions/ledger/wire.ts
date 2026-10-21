/**
 * ledger-wire extension, the payload side of the ledger (extensions/ledger/index.ts
 * has the request side and the design). Its `before_provider_request` hook
 * runs after every hook that shapes the tail (system-reminder's layout,
 * tool-search, context-management) and before cache-marks:
 *
 * 1. Inside an epoch it splices: the base request's recorded list, then pi's
 *    rendering of the tail, under the recorded system prompt and tools, with
 *    tools added mid-epoch appended (lib/ledger/wire.ts spliceRequest).
 * 2. It validates the request (lib/ledger/validate.ts): no reference to an
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
 * plan of the request it warms, so it resends that request as it went out
 * (with the warm's cap), or after a `/reload` (no plan here: pi's context is
 * the tail the old instance cut) the branch's last request. Every other
 * payload follows a context pass: pi's retry runs one too, and a second
 * payload under a sent plan with a full cap is pi-ai's strict-tools fallback,
 * a real re-send.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestIdentity } from "../lib/anthropic-auth.ts";
import { notifyOrPrint } from "../lib/headless-output.ts";
import { foldBranch } from "../lib/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, LEDGER_SENT_CHANNEL, type LedgerSent, type RequestPlan } from "../lib/ledger/plan.ts";
import { type EntryLike, makeRecord, RECORD, type ToldFact } from "../lib/ledger/records.ts";
import { deliveredAfterRepair, repairRequest, validateRequest } from "../lib/ledger/validate.ts";
import { appendPoint, encodeRequest, hasWarmCap, type RecordedRequest, recordedBody, recordedRequest, spliceRequest, type WirePayload, withRequestFields } from "../lib/ledger/wire.ts";
import { extensionVersion } from "../lib/package-version.ts";

export default function ledgerWireExtension(pi: ExtensionAPI) {
	const by = extensionVersion();
	/** The plan of the last `context` pass; a warm re-runs only this hook and reuses it. */
	let plan: RequestPlan | undefined;
	/** Whether a request went out under `plan`: a later payload with the warm cap is then a warm. */
	let sent = false;
	/** What this hook recorded under `plan`: the request, and the hashes it stored, so a re-send stores only new bodies. */
	let recorded: { request: RecordedRequest; hashes: Set<string> } | undefined;
	/** The last session request this instance sent, as it left this hook: what a warm resends. */
	let lastSent: WirePayload | undefined;
	/** Problems already reported this session, so a recurring bug is one notice. */
	const reported = new Set<string>();

	pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
		plan = data as RequestPlan;
		sent = false;
		recorded = undefined;
	});
	pi.on("session_start", () => {
		plan = undefined;
		sent = false;
		recorded = undefined;
		lastSent = undefined;
		reported.clear();
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const identity = requestIdentity(model);
		if (!model || !identity) return undefined;
		const api = model.api;
		const live = event.payload as WirePayload;
		const current = plan;

		// A cache warm: the request it warms, as sent, under the warm's cap.
		if ((!current || sent) && hasWarmCap(live)) {
			if (lastSent) return withRequestFields(lastSent, live);
			const base = foldBranch(ctx.sessionManager.getBranch() as EntryLike[], identity).lastRequest;
			return base ? recordedBody(base, live, api) : undefined;
		}
		// No context pass in this instance and not a warm: leave pi's request alone.
		if (!current) return undefined;

		let payload = live;
		if (!current.epoch && current.base) payload = spliceRequest(current.base, payload, api);
		const spliced = payload;
		let delivered: { consumed: string[]; facts: ToldFact[] } = { consumed: current.consumed, facts: current.facts };

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

		// The recorded prefix is known, unless a repair moved its elements.
		const base = current.base;
		const request = recordedRequest(payload, identity, base && payload === spliced ? { base, end: appendPoint(base.list, api) } : undefined);
		lastSent = payload;
		sent = true;
		// The same request again under this plan (pi-ai re-sending an identical body) records nothing new.
		if (recorded && encodeRequest(recorded.request, request, { has: () => true }) === undefined) return payload === live ? undefined : payload;
		const known = { has: (hash: string) => current.fold.knownHashes.has(hash) || recorded?.hashes.has(hash) === true };
		const delta = encodeRequest(current.fold.lastRequest, request, known);
		if (delta) {
			if (current.epoch) pi.appendEntry(RECORD.epoch, makeRecord("epoch", by, { cause: current.cause ?? "first" }));
			pi.appendEntry(RECORD.request, makeRecord("request", by, { ...delta, covers: current.covers, consumed: delivered.consumed }));
			if (delivered.facts.length > 0) pi.appendEntry(RECORD.told, makeRecord("told", by, { facts: delivered.facts }));
			recorded = { request, hashes: new Set([...(recorded?.hashes ?? []), ...Object.keys(delta.blobs)]) };
			pi.events.emit(LEDGER_SENT_CHANNEL, { payload, model, sessionId: ctx.sessionManager.getSessionId(), plan: current } satisfies LedgerSent);
		}
		return payload === live ? undefined : payload;
	});
}
