/**
 * A side call sent as a replay of the session's last provider request, for the
 * extensions that consume the compaction extension's capture (btw, recap). The
 * shape rules are in request-replay.ts; this is the wiring they share.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionRequestHeaders } from "../context-management/index.ts";
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
 * Send `prompt` as the replay of the last request on `model`, returning the
 * answer's text. Undefined when there is no capture for `model`, too little
 * output room is left, there is no API key, the call failed, or the reply
 * held no text (the replayed request declares the session's tools, so the
 * model can answer with a tool call), so the caller runs its standalone call
 * instead; an empty string when the caller's own signal aborted it. Throws
 * when `timeoutMs` ran out: the time budget is spent, so a standalone call
 * must not start a second one.
 */
export async function replaySideCall(
	ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">,
	model: Model<Api>,
	exchange: SessionExchange,
	prompt: string,
	options: { signal: AbortSignal; timeoutMs: number; onUsage: (usage: Usage) => void },
): Promise<string | undefined> {
	const wire = exchange.forModel(model);
	if (!wire) return undefined;
	const tail = replayTail(wire.reply as Message | undefined, prompt);
	const cap = replayOutputCap(wire.capture, tail);
	if (cap === undefined) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	const baseUrl = (auth as { baseUrl?: string }).baseUrl;
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const result = await completeSimple(
		baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model,
		{ systemPrompt: "", messages: tail, tools: [] },
		{
			apiKey: auth.apiKey,
			headers: sessionRequestHeaders(model, auth.headers),
			env: auth.env,
			signal: AbortSignal.any([options.signal, timeout]),
			maxTokens: cap,
			sessionId: ctx.sessionManager.getSessionId(),
			onPayload: (payload) => extendPayload(wire.capture, payload as Record<string, unknown>, cap),
		},
	);
	options.onUsage(result.usage);
	if (options.signal.aborted) return "";
	if (timeout.aborted) throw new Error(`No answer within ${Math.round(options.timeoutMs / 1000)} seconds.`);
	if (result.stopReason === "aborted" || result.stopReason === "error") return undefined;
	return answerText(result.content) || undefined;
}
