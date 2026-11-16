/** Opt-in side-call cache evidence, independent of the provider's transport. */
import { knobValue } from "../profile/knobs.ts";
import { appendFileSync } from "node:fs";

/** Every side-call kind; releaseSideCalls closes each one's pi-ai key. */
export const SIDE_CALL_KINDS = ["reader", "btw", "recap", "title", "setup"] as const;

export interface SideCallLogContext {
	kind: (typeof SIDE_CALL_KINDS)[number];
	model: { provider: string; id: string; api: string };
	sessionId: string;
	system: string;
	messages: readonly unknown[];
}

/**
 * *_SIDE_CALL_LOG names a JSONL file containing prompt text and normalized
 * usage, never credentials or response text. Like *_AUTO_MODE_LOG, this is
 * explicitly opt-in and never read back. Log every completed provider attempt,
 * including reasoning retries; a probe must not mistake an error for a hit.
 */
export function logSideCallUsage(call: SideCallLogContext, reply: { usage?: unknown; stopReason: string }): void {
	appendSideCallLog(call, { system: call.system, messages: call.messages, usage: reply.usage, stopReason: reply.stopReason });
}

/**
 * A side call that gave up before an answer it could use, with the reason, in
 * the same opt-in log. `kind` names the caller (`compaction` logs only these);
 * the row carries `failed` and no `usage`, so a usage reader can tell it apart.
 */
export function logSideCallFailure(call: SideCallIdentity, reason: string): void {
	appendSideCallLog(call, { failed: reason });
}

/** What every row names first: the caller, the model and the call's session key. */
interface SideCallIdentity {
	kind: string;
	model: { provider: string; id: string; api: string };
	sessionId: string;
}

/** Append one row to the opt-in log, when it is on. */
function appendSideCallLog(call: SideCallIdentity, fields: Record<string, unknown>): void {
	const path = knobValue("SIDE_CALL_LOG");
	if (!path) return;
	try {
		appendFileSync(path, `${JSON.stringify({ kind: call.kind, model: `${call.model.provider}/${call.model.id}`, api: call.model.api, sessionId: call.sessionId, ...fields })}\n`);
	} catch {
		// A diagnostic log that cannot be written must not fail a side call.
	}
}
