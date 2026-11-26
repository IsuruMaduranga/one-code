/**
 * One standalone side call: a single request through pi's model runtime
 * (`completeThreadless`) outside the main agent loop, shared by `/btw`, the
 * recap, the web_fetch reader, the session title and the auto-mode setup
 * draft. The auto-mode classifier has its own transport and stays out of this.
 *
 * Every side call takes the same steps: let pi resolve the model's credential
 * and base URL (once, inside the call; a refusal comes back with its cause in
 * the reply, `completeThreadless`), combine the caller's abort signal with a
 * per-attempt timeout, key the request to the session (`<session id>:<kind>`,
 * stable across calls, so the provider's prompt cache is reused), apply the
 * caller's cache placement on the APIs it covers, log the attempt
 * (`*_SIDE_CALL_LOG`), retry with thinking on when the model cannot disable
 * it, and report usage for the footer cost. The request on the wire is exactly
 * what each extension built inline before (`side-call-run-wire.test.ts`).
 *
 * Kept apart from `side-call.ts`, which stays free of runtime pi imports for
 * the pure prompt modules that use it.
 */

import { type Api, type Context, cleanupSessionResources, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import { completeThreadless, type SideCallRegistry, type SideCallReply } from "../request/anthropic-stream.ts";
import { withReasoningFallback } from "../models/model-policy.ts";
import { withSideCallIgnoredHosts } from "../request/openrouter-ignored-hosts.ts";
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
	/** pi's model registry, which resolves `model`'s credential inside the call; one that does not resolve comes back as a reply with `stopReason: "error"` and `credentialError`. */
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
 * after its answer (findings §59). The permissions extension, which is
 * required and so always loaded, calls it on `session_shutdown`, and
 * `disposeChildSession` for a child, which never gets that event; a new kind
 * is released with no further change. pi runs the shutdown handlers in load
 * order, so an owner whose call can still be out at shutdown (btw, recap, the
 * session title) also releases its own kind after aborting that call: a call
 * that finished between the two keeps its socket, and only the owner's
 * release is sure to come after it, wherever the owner loads.
 */
export function releaseSideCalls(sessionId: string): void {
	for (const kind of SIDE_CALL_KINDS) releaseSideCall(sessionId, kind);
}

/** Close what pi-ai holds open under one side-call kind's key; call it after aborting the kind's in-flight call. */
export function releaseSideCall(sessionId: string, kind: SideCallKind): void {
	cleanupSessionResources(sideCallKey(sessionId, kind));
}

/** Run the side call and return the final reply; a provider or credential failure is in its `stopReason` (a credential one also in `credentialError`). */
export async function runSideCall(run: SideCallRun): Promise<SideCallReply> {
	const { kind, context } = run;
	// Its own OpenRouter session picks its own host, which no notice names: skip the hosts measured missing the cache.
	const model = withSideCallIgnoredHosts(run.model);
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
