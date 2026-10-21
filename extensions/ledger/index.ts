/**
 * ledger extension, the request side of the record-once design
 * (working-docs/features/lifecycle-grid-hunt/design.md sections 2 and 5): the
 * request is a pure function of the branch. Every request is recorded on the
 * branch as it went on the wire (`ledger/wire.ts`, the payload side), and the
 * next request inside the same epoch takes every byte above its append point
 * from that record instead of from a rebuild.
 *
 * Its `context` hook runs right after kept-thinking, before anything injects:
 *
 * - it folds the branch (lib/ledger/fold.ts) and decides whether this request
 *   opens an epoch (lib/ledger/plan.ts planRequest);
 * - inside an epoch it cuts the messages the last request covered, so pi and
 *   every later `context` hook see only the tail, and the payload side puts
 *   the recorded list in front of what pi renders for it;
 * - it publishes the plan on LEDGER_PLAN_CHANNEL for the renderer
 *   (system-reminder) and the payload side.
 *
 * Resume, `/reload`, `/fork` and `/tree` need no restore code: each folds a
 * different branch. pi keeps a `/tree` move only in memory, so `session_tree`
 * appends a `one-code:branch` record, which makes the selected leaf the one a
 * reopened file resumes on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestIdentity } from "../lib/anthropic-auth.ts";
import { foldBranch } from "../lib/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, planRequest } from "../lib/ledger/plan.ts";
import { type EntryLike, makeRecord, RECORD } from "../lib/ledger/records.ts";
import { extensionVersion } from "../lib/package-version.ts";

export default function ledgerExtension(pi: ExtensionAPI) {
	const by = extensionVersion();

	pi.on("session_tree", (event) => {
		pi.appendEntry(RECORD.branch, makeRecord("branch", by, { fromLeafId: event.oldLeafId ?? "" }));
	});

	pi.on("context", (event, ctx) => {
		const fold = foldBranch(ctx.sessionManager.getBranch() as EntryLike[], ctx.model ? requestIdentity(ctx.model) : undefined);
		const { plan, tailStart } = planRequest(fold, event.messages as Array<{ role: string; timestamp?: number }>);
		pi.events.emit(LEDGER_PLAN_CHANNEL, plan);
		return tailStart > 0 ? { messages: event.messages.slice(tailStart) } : undefined;
	});
}
