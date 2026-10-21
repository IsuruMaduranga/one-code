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
 * 3. It records the request as a delta against the last one on the branch,
 *    with the pending items it carried and what its new blocks told the
 *    model, and publishes it (LEDGER_SENT_CHANNEL) for the side calls that
 *    replay it (compaction's summarizer, btw, recap, forks). A request that
 *    adds nothing (a pi cache warm, a provider retry) records and publishes
 *    nothing, and it is answered from the same plan, so a warm warms exactly
 *    what was sent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { authKind } from "../lib/anthropic-auth.ts";
import { notifyOrPrint } from "../lib/headless-output.ts";
import { foldBranch } from "../lib/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, LEDGER_SENT_CHANNEL, type LedgerSent, type RequestPlan } from "../lib/ledger/plan.ts";
import { type EntryLike, makeRecord, RECORD } from "../lib/ledger/records.ts";
import { repairRequest, validateRequest } from "../lib/ledger/validate.ts";
import { encodeRequest, spliceRequest, type WirePayload } from "../lib/ledger/wire.ts";
import { extensionVersion } from "../lib/package-version.ts";

export default function ledgerWireExtension(pi: ExtensionAPI) {
	const by = extensionVersion();
	/** The plan of the last `context` pass; a warm or a retry re-runs only this hook and reuses it. */
	let plan: RequestPlan | undefined;
	/** Problems already reported this session, so a recurring bug is one notice. */
	const reported = new Set<string>();

	pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
		plan = data as RequestPlan;
	});
	pi.on("session_start", () => {
		plan = undefined;
		reported.clear();
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		// No context pass in this instance (a warm that outlived a /reload): leave pi's request alone.
		if (!model || !plan) return undefined;
		const api = model.api;
		let payload = event.payload as WirePayload;
		if (!plan.epoch && plan.base) payload = spliceRequest(plan.base, payload, api);

		const problems = validateRequest(payload, api);
		if (problems.length > 0) {
			const fresh = problems.map((problem) => JSON.stringify(problem)).filter((key) => !reported.has(key));
			for (const key of fresh) reported.add(key);
			if (fresh.length > 0) notifyOrPrint(ctx, `One Code: the request had ${problems.length} problem(s) the ledger ${process.env.ONE_CODE_LEDGER_STRICT === "1" ? "left in place" : "removed"}: ${fresh.join(", ")}`, "warning");
			if (process.env.ONE_CODE_LEDGER_STRICT !== "1") payload = repairRequest(payload, api, problems);
		}

		const identity = { api, provider: model.provider, model: model.id, auth: authKind(model.provider) };
		const fold = foldBranch(ctx.sessionManager.getBranch() as EntryLike[]);
		const delta = encodeRequest(fold.lastRequest, payload, identity, fold.knownHashes);
		if (delta) {
			if (plan.epoch) pi.appendEntry(RECORD.epoch, makeRecord("epoch", by, { cause: plan.cause ?? "first" }));
			pi.appendEntry(RECORD.request, makeRecord("request", by, { ...delta, covers: plan.covers, consumed: plan.consumed }));
			if (plan.facts.length > 0) pi.appendEntry(RECORD.told, makeRecord("told", by, { facts: plan.facts }));
			// A warm or a retry is the same request again: the side calls keep the one they have.
			pi.events.emit(LEDGER_SENT_CHANNEL, { payload, model, sessionId: ctx.sessionManager.getSessionId(), plan } satisfies LedgerSent);
		}
		return payload === event.payload ? undefined : payload;
	});
}
