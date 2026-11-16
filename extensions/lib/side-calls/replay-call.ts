/**
 * A side call sent as a replay of the session's last provider request, for the
 * extensions that consume the compaction extension's capture (btw, recap). The
 * shape rules are in request-replay.ts; this is the wiring they share.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import { completeThreadless } from "../request/anthropic-stream.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionRequestHeaders } from "../request/context-management.ts";
import { extendPayload, LAST_REQUEST_CHANNEL, LastExchange, type RequestCapture, replayOutputCap, replayTail } from "./request-replay.ts";
import { answerText } from "./side-call.ts";

export type SessionExchange = LastExchange<AgentMessage & { role: string }>;

/** The last captured request and its reply, kept current from the capture channel and `message_end`. */
export function followLastExchange(pi: ExtensionAPI): SessionExchange {
	const exchange: SessionExchange = new LastExchange();
	pi.events.on(LAST_REQUEST_CHANNEL, (capture) => exchange.setCapture(capture as RequestCapture | undefined));
	pi.on("message_end", (event) => exchange.noteMessage(event.message as AgentMessage & { role: string }));
	return exchange;
}

/**
 * Send `prompt` as the replay of the last request on `model`, after
 * `options.history` (earlier side exchanges), returning the answer's text.
 * Undefined when there is no capture for `model`, too little output room is
 * left, the call failed, or the reply called a tool or held no text (the
 * replayed request declares the session's tools, and text beside a tool call
 * is a preamble, not the answer), so the caller runs its standalone call
 * instead; an empty string when the caller's own signal aborted it. Throws
 * when `timeoutMs` ran out (the time budget is spent, so a standalone call
 * must not start a second one) and on a credential refusal, with its message:
 * the standalone call goes to the same provider and would be refused again.
 */
export async function replaySideCall(
	ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">,
	model: Model<Api>,
	exchange: SessionExchange,
	prompt: string,
	options: { signal: AbortSignal; timeoutMs: number; onUsage: (usage: Usage) => void; history?: readonly Message[] },
): Promise<string | undefined> {
	const wire = exchange.forModel(model);
	if (!wire) return undefined;
	const tail = replayTail(wire.reply as Message | undefined, prompt, Date.now(), options.history);
	const cap = replayOutputCap(wire.capture, tail);
	if (cap === undefined) return undefined;
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const result = await completeThreadless(
		ctx.modelRegistry,
		model,
		{ systemPrompt: "", messages: tail, tools: [] },
		{
			headers: sessionRequestHeaders(model),
			signal: AbortSignal.any([options.signal, timeout]),
			maxTokens: cap,
			sessionId: ctx.sessionManager.getSessionId(),
			onPayload: (payload) => extendPayload(wire.capture, payload as Record<string, unknown>, cap),
		},
	);
	options.onUsage(result.usage);
	if (options.signal.aborted) return "";
	if (timeout.aborted) throw new Error(`No answer within ${Math.round(options.timeoutMs / 1000)} seconds.`);
	if (result.credentialError) throw new Error(result.errorMessage);
	if (result.stopReason === "aborted" || result.stopReason === "error" || result.stopReason === "toolUse") return undefined;
	return answerText(result.content) || undefined;
}
