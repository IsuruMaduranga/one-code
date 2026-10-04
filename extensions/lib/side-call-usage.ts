/** Opt-in side-call cache evidence, independent of the provider's transport. */
import { appendFileSync } from "node:fs";

export interface SideCallLogContext {
	kind: "reader" | "btw" | "recap";
	model: { provider: string; id: string; api: string };
	sessionId: string;
	system: string;
	messages: readonly unknown[];
}

/**
 * CC_SIDE_CALL_LOG names a JSONL file containing prompt text and normalized
 * usage, never credentials or response text. Like CC_AUTO_MODE_LOG, this is
 * explicitly opt-in and never read back. Log every completed provider attempt,
 * including reasoning retries; a probe must not mistake an error for a hit.
 */
export function logSideCallUsage(call: SideCallLogContext, reply: { usage?: unknown; stopReason: string }): void {
	const path = process.env.CC_SIDE_CALL_LOG;
	if (!path) return;
	try {
		appendFileSync(path, `${JSON.stringify({
			kind: call.kind,
			model: `${call.model.provider}/${call.model.id}`,
			api: call.model.api,
			sessionId: call.sessionId,
			system: call.system,
			messages: call.messages,
			usage: reply.usage,
			stopReason: reply.stopReason,
		})}\n`);
	} catch {
		// A diagnostic log that cannot be written must not fail a side call.
	}
}
