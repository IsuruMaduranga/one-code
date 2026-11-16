/**
 * One standalone side call: a single request through pi's model runtime
 * (`completeThreadless`) outside the main agent loop, shared by `/btw`, the
 * recap, the web_fetch reader, the session title and the auto-mode setup
 * draft. The auto-mode classifier has its own transport and stays out of this.
 *
 * Every side call takes the same steps: let pi resolve the model's credential
 * and base URL, combine the caller's abort signal with a per-attempt timeout, key the request to the session (`<session id>:<kind>`,
 * stable across calls, so the provider's prompt cache is reused), apply the
 * caller's cache placement on the APIs it covers, log the attempt
 * (`*_SIDE_CALL_LOG`), retry with thinking on when the model cannot disable
 * it, and report usage for the footer cost. The request on the wire is exactly
 * what each extension built inline before (`side-call-run-wire.test.ts`).
 *
 * Kept apart from `side-call.ts`, which stays free of runtime pi imports for
 * the pure prompt modules that use it.
 */

import { type Api, type AssistantMessage, type Context, cleanupSessionResources, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import { completeThreadless, type SideCallRegistry } from "../request/anthropic-stream.ts";
import { withReasoningFallback } from "../models/model-policy.ts";
import { SIDE_CALL_KINDS, type SideCallLogContext, logSideCallUsage } from "./side-call-usage.ts";

/** A payload hook that places cache breakpoints, and the APIs whose payload shape it handles. */
export interface SideCallCachePlacement {
	apis: ReadonlySet<string>;
	place: (payload: unknown) => void;
}

export interface SideCallRun {
	/** Names the call in the cache key and the side-call log. */
	kind: SideCallLogContext["kind"];
	model: Model<Api>;
	/** pi's model registry, which resolves `model`'s credential (the caller checks it can, and handles a failed lookup). */
	registry: SideCallRegistry;
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

type SideCallKind = SideCallLogContext["kind"];

/** A side call's cache key, `<session id>:<kind>`, which pi-ai also takes as its `sessionId`. */
export function sideCallKey(sessionId: string, kind: SideCallKind): string {
	return `${sessionId}:${kind}`;
}

/**
 * Close what pi-ai holds open under a session's side-call keys, every kind's
 * (a key never used costs nothing). On openai-codex it keeps one WebSocket per
 * `sessionId` with a 5-minute idle timer holding the process, and pi's own
 * dispose closes only the session's id, so a `pi -p` run waited out the timer
 * after its answer (findings §59). Every extension that runs a side call calls
 * it as the session ends, so a new kind is released with no further change.
 */
export function releaseSideCalls(sessionId: string): void {
	for (const kind of SIDE_CALL_KINDS) cleanupSessionResources(sideCallKey(sessionId, kind));
}

/** Run the side call and return the final reply; a provider or credential failure is in its `stopReason`. */
export async function runSideCall(run: SideCallRun): Promise<AssistantMessage> {
	const { kind, model, context } = run;
	const sessionId = sideCallKey(run.sessionId, kind);
	const onPayload = run.cache?.apis.has(model.api) ? run.cache.place : undefined;
	return withReasoningFallback(
		model,
		async (reasoning) => {
			const timeout = AbortSignal.timeout(run.timeoutMs);
			const reply = await completeThreadless(run.registry, model, context, {
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
