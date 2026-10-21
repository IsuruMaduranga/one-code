/**
 * The whole conversation each request covers, as pi built it, for the side
 * calls that replay it (compaction's summarizer, btw, recap). Inside an epoch
 * the ledger (extensions/ledger) cuts a request to its tail before every later
 * `context` hook, so the full list comes with the request's plan instead.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "./ledger/plan.ts";

/** Call `onRequest` at each request's `context` pass with every message the request covers. */
export function followCoveredMessages(pi: ExtensionAPI, onRequest: (messages: AgentMessage[], ctx: ExtensionContext) => void): void {
	let planned: readonly AgentMessage[] | undefined;
	pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
		planned = (data as RequestPlan).messages as readonly AgentMessage[];
	});
	pi.on("context", (event, ctx) => {
		onRequest([...(planned ?? event.messages)], ctx);
		planned = undefined;
	});
}
