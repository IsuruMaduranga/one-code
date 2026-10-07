/**
 * One standalone side call: a single `completeSimple` request outside the main
 * agent loop, shared by `/btw`, the recap and the web_fetch reader. The
 * auto-mode classifier has its own transport and stays out of this.
 *
 * Every side call takes the same steps: splice the provider's base URL from the
 * resolved auth into the model, combine the caller's abort signal with a
 * per-attempt timeout, key the request to the session (`<session id>:<kind>`,
 * stable across calls, so the provider's prompt cache is reused), apply the
 * caller's cache placement on the APIs it covers, log the attempt
 * (`CC_SIDE_CALL_LOG`), retry with thinking on when the model cannot disable
 * it, and report usage for the footer cost. The request on the wire is exactly
 * what each extension built inline before (`side-call-run-wire.test.ts`).
 *
 * Kept apart from `side-call.ts`, which stays free of runtime pi imports for
 * the pure prompt modules that use it.
 */

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { withReasoningFallback } from "./model-policy.ts";
import { type SideCallLogContext, logSideCallUsage } from "./side-call-usage.ts";

/** A payload hook that places cache breakpoints, and the APIs whose payload shape it handles. */
export interface SideCallCachePlacement {
	apis: ReadonlySet<string>;
	place: (payload: unknown) => void;
}

export interface SideCallRun {
	/** Names the call in the cache key and the side-call log. */
	kind: SideCallLogContext["kind"];
	model: Model<Api>;
	/** The model registry's resolved auth for `model` (the caller handles a failed lookup). */
	auth: { apiKey?: string; headers?: SimpleStreamOptions["headers"]; env?: Record<string, string>; baseUrl?: string };
	/** The session's id; the call's cache key is `<sessionId>:<kind>`. */
	sessionId: string;
	context: Context;
	signal?: AbortSignal;
	/** Applies to each attempt on its own, so a reasoning retry gets a full timeout. */
	timeoutMs: number;
	maxTokens: number;
	/** Cache placement for the payload; none leaves pi-ai's own markers. */
	cache?: SideCallCachePlacement;
	/** Per-session memo of a model's required thinking level (`withReasoningFallback`). */
	learnedReasoning?: Map<string, ThinkingLevel>;
	/** Each attempt's usage, for the footer's all-in cost. */
	onUsage: (usage: unknown) => void;
}

/** Run the side call and return the final reply; a provider failure is in its `stopReason`, as with `completeSimple`. */
export async function runSideCall(run: SideCallRun): Promise<AssistantMessage> {
	const { kind, model, auth, context } = run;
	const sessionId = `${run.sessionId}:${kind}`;
	const target = auth.baseUrl ? ({ ...model, baseUrl: auth.baseUrl } as Model<Api>) : model;
	const onPayload = run.cache?.apis.has(model.api) ? run.cache.place : undefined;
	return withReasoningFallback(
		model,
		async (reasoning) => {
			const timeout = AbortSignal.timeout(run.timeoutMs);
			const reply = await completeSimple(target, context, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: run.signal ? AbortSignal.any([run.signal, timeout]) : timeout,
				maxTokens: run.maxTokens,
				sessionId,
				...(onPayload ? { onPayload } : {}),
				...(reasoning ? { reasoning } : {}),
			});
			logSideCallUsage({ kind, model, sessionId, system: context.systemPrompt ?? "", messages: context.messages }, reply);
			return reply;
		},
		run.learnedReasoning,
		run.onUsage,
	);
}
