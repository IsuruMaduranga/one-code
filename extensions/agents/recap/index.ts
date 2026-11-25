/**
 * recap extension: Claude Code's "while you were away" summary (the ※ line).
 *
 * Claude Code 2.1.330 fires it 3 minutes after a turn ends, once the terminal
 * is blurred; pi exposes no terminal focus/blur event, so the closest faithful
 * trigger is an idle timer: armed when a turn ends, held back 30 s after any
 * keystroke (onTerminalInput) and cleared while a turn runs. The delay is capped at 0.8
 * of the prompt cache's lifetime. When it fires, Claude Code's skips apply in
 * its order (policy.ts, findings §102): a stale cache, the rate limit, a draft
 * in the prompt box, background agents or workflows, a pending wakeup, a recap
 * in flight, three failures this turn, and too few user turns (three in all,
 * two since the last recap, counted on the branch).
 *
 * Generation is Claude Code 2.1.261's: the session's last provider request
 * replayed unchanged on the session model, the reply that answered it, then
 * the verbatim prompt, so the call reads the cache the session wrote and
 * writes the reply for the user's next turn (lib/side-calls/request-replay.ts; the
 * compaction extension publishes the capture). Without a capture for the
 * session model, or on a provider API the replay does not cover, it falls back
 * to a small standalone call on a cheap same-containment model
 * (pickEconomicalContainedModel): the current branch's last 30 messages (read
 * from the session when the recap runs) and name-only stubs of
 * the active tools (some providers reject a history carrying tool_use blocks
 * with no tools declared). The result is a display-only entry (appendEntry,
 * not in LLM context); the first three of a run end with how to turn recaps
 * off. Best-effort throughout: any failure just shows nothing.
 *
 * Deviations from CC, logged in working-docs/decisions: the session-memory block is
 * omitted (decoupling). Turning the `recap` feature off opts out; *_RECAP_IDLE_MS
 * overrides the 3-minute delay.
 */

import { knobValue } from "../../lib/profile/knobs.ts";
import { brandedId, envName } from "../../lib/profile/brand.mjs";
import { feature } from "../../lib/profile/feature.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { followLastExchange, replaySideCall } from "../../lib/side-calls/replay-call.ts";
import { recordUsage } from "../../lib/notify/usage-bus.ts";
import { pendingWork, wakeupPending } from "../../lib/notify/session-work.ts";
import { hasOneHourCache, rateLimitStatus as responseRateLimitStatus } from "../../lib/request/anthropic-payload.ts";
import { pickEconomicalContainedModel } from "../../lib/models/model-tier.ts";
import { CONVERSATION_CACHE_PLACEMENT } from "../../lib/side-calls/side-call-cache.ts";
import { releaseSideCall, runSideCall } from "../../lib/side-calls/side-call-run.ts";
import { answerText, branchMessages, stripImageBlocks, toolStubs, withoutSystemMessages } from "../../lib/side-calls/side-call.ts";
import { unrefTimers } from "../../lib/core/timer-ops.ts";
import { dimMarkedLine } from "../../lib/ui/tui-render.ts";
import { featureEnabled, requireText } from "../../lib/profile/profile.ts";
import { recapLine, recentForRecap, REFERENCE_MARK } from "./prompt.ts";
import { type BranchMark, FIVE_MINUTE_CACHE_MS, HINTED_RECAPS, ONE_HOUR_CACHE_MS, RECAP_DELAY_MS, recapDelayMs, recapSkip } from "./policy.ts";
import { RecapScheduler } from "./scheduler.ts";
import { recapResultText } from "./text.ts";

const ENTRY_TYPE = brandedId("recap");
const RECAP_MAX_TOKENS = 256; // 1-3 short sentences
const RECAP_TIMEOUT_MS = 30_000;

/** The configured delay before a recap, overridable via *_RECAP_IDLE_MS (floor 1s). */
function configuredDelayMs(): number {
	const raw = Number(knobValue("RECAP_IDLE_MS"));
	return Number.isFinite(raw) && raw >= 1000 ? raw : RECAP_DELAY_MS;
}

/** A branch entry as the turn count sees it: Claude Code counts every user-type message, tool results and shell input included. */
function branchMark(entry: { type: string; customType?: string; message?: { role?: string } }): BranchMark {
	if (entry.type === "custom") return entry.customType === ENTRY_TYPE ? "recap" : undefined;
	const role = entry.type === "message" ? entry.message?.role : undefined;
	return role === "user" || role === "toolResult" || role === "bashExecution" ? "user" : undefined;
}

interface RecapData {
	content: string;
}

function recapExtension(pi: ExtensionAPI) {
	const text = requireText("recap");
	pi.registerEntryRenderer<RecapData>(ENTRY_TYPE, (entry, _options, theme) => {
		const content = entry.data?.content;
		if (!content) return undefined;
		return dimMarkedLine(theme, REFERENCE_MARK, recapLine(content));
	});

	// The session's last request as it went on the wire, and the reply that answered it.
	const exchange = followLastExchange(pi);

	let lastCtx: ExtensionContext | undefined;
	let inFlight: AbortController | undefined;
	let inputHookRegistered = false;
	/** When the last turn ended in this session; the cache's age is measured from it. */
	let lastTurnEndAt: number | undefined;
	let rateLimitStatus: string | undefined;
	/** Recaps shown in this run (Claude Code counts per process), for the turn-off hint on the first ones. */
	let shown = 0;

	/** The lifetime of the cache the recap reads: one hour when the last request asked for it, else the provider's five minutes. */
	const cacheLifetimeMs = (model: Model<Api> | undefined) => (hasOneHourCache(exchange.forModel(model)?.capture.payload) ? ONE_HOUR_CACHE_MS : FIVE_MINUTE_CACHE_MS);

	const abortInFlight = () => {
		inFlight?.abort();
		inFlight = undefined;
	};

	const scheduler = new RecapScheduler(
		unrefTimers,
		Date.now,
		() => recapDelayMs(configuredDelayMs(), cacheLifetimeMs(lastCtx?.model)),
		() => true,
		() => void generate(),
	);

	/** The fallback: a small standalone call on a cheap same-containment model. */
	async function standaloneRecap(ctx: ExtensionContext, model: Model<Api>, messages: AgentMessage[], signal: AbortSignal): Promise<string> {
		const choice = pickEconomicalContainedModel(ctx.modelRegistry.getAvailable(), model);
		if (!choice) return "";
		// Name-only stubs of the active tools, so a history carrying tool_use
		// blocks stays valid on strict providers (see the header note) without
		// shipping every full schema (~6k tokens) to a call that must answer
		// in text.
		const tools = toolStubs(pi.getActiveTools(), recapResultText.stubReason);

		const recent = recentForRecap(withoutSystemMessages(messages));
		// The cheap reader may be a text-only model, and the recap does not need
		// images — strip them so a pasted image or one a Read returned cannot break
		// the call (working-docs/decisions/model-policy.md).
		const recapMessages = [...stripImageBlocks(convertToLlm(recent)), { role: "user" as const, content: text.prompt, timestamp: Date.now() }];
		// Thinking off unless the model cannot disable it; withReasoningFallback
		// sends a level up front for catalog-marked models and retries on the 400
		// for the rest. Fires on a minutes-long idle timer, so no cross-call memo.
		const result = await runSideCall({
			kind: "recap",
			model: choice.model,
			registry: ctx.modelRegistry,
			sessionId: ctx.sessionManager.getSessionId(),
			context: { systemPrompt: "", messages: recapMessages, tools },
			signal,
			timeoutMs: RECAP_TIMEOUT_MS,
			maxTokens: RECAP_MAX_TOKENS,
			cache: CONVERSATION_CACHE_PLACEMENT,
			onUsage: (usage) => recordUsage(pi, "recap", usage),
		});
		return answerText(result.content);
	}

	async function generate() {
		const ctx = lastCtx;
		const model = ctx?.model as Model<Api> | undefined;
		if (!ctx?.hasUI || !model) return;
		const pending = pendingWork(pi.events);
		const skip = recapSkip({
			now: Date.now(),
			lastTurnEndAt,
			cacheLifetimeMs: cacheLifetimeMs(model),
			rateLimitStatus,
			draft: ctx.ui.getEditorText(),
			pendingAgents: pending.agents,
			pendingWorkflows: pending.workflows,
			wakeupPending: wakeupPending(pi.events),
			inFlight: inFlight !== undefined,
			failuresThisTurn: scheduler.failuresThisTurn,
			marks: ctx.sessionManager.getBranch().map(branchMark),
		});
		if (skip !== null) return;
		// The current branch, read now: a /tree or a compaction since the last
		// request changed it, and pi fires no `context` event for either.
		const messages = branchMessages(ctx);
		if (!messages.length) return;
		const controller = new AbortController();
		inFlight = controller;
		try {
			const replayed = await replaySideCall(ctx, model, exchange, text.prompt, {
				signal: controller.signal,
				timeoutMs: RECAP_TIMEOUT_MS,
				onUsage: (usage) => recordUsage(pi, "recap", usage),
			});
			const content = replayed ?? (await standaloneRecap(ctx, model, messages, controller.signal));
			if (controller.signal.aborted) return;
			if (!content) {
				scheduler.markFailed();
				return;
			}
			const hinted = shown < HINTED_RECAPS;
			shown++;
			pi.appendEntry<RecapData>(ENTRY_TYPE, { content: hinted ? `${content} ${featureEnabled("config") ? recapResultText.offHint : recapResultText.offHintWithoutConfig(envName("FEATURES_OFF"))}` : content });
		} catch {
			// Best-effort: a failed recap shows nothing. Claude Code tries again on the
			// next blur (here, the next idle period) up to three failures a turn.
			// An abort means a new turn or session already reset the scheduler; a late
			// count there would spend that turn's budget.
			if (!controller.signal.aborted) scheduler.markFailed();
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		// A new session (including after /clear): drop any timer armed by the
		// previous session, so a stale recap can never surface against the
		// fresh conversation.
		scheduler.reset();
		abortInFlight();
		lastTurnEndAt = undefined;
		rateLimitStatus = undefined;
		if (!ctx.hasUI) return;
		// Reset the idle clock on any keystroke — the closest signal to CC's
		// terminal-blur trigger pi exposes. Registered ONCE (session_start fires
		// again on every /clear and session switch, so an unguarded registration
		// would leak a growing stack of listeners); the handler drives the
		// scheduler, which reads only its own state.
		if (inputHookRegistered) return;
		inputHookRegistered = true;
		ctx.ui.onTerminalInput(() => {
			scheduler.interacted();
			return undefined; // observe only; never consume the keystroke
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		scheduler.turnStarted();
		abortInFlight();
	});

	// Settle, not agent_end: `agent_end` fires per run, and arming the idle
	// timer there could fire a recap during a retry backoff longer than the
	// configured idle (*_RECAP_IDLE_MS floors at 1s): a recap mid-turn, or a
	// failed one spending the turn's failure budget.
	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		// Unconditional: turnEnded() both clears turn state and arms the idle
		// timer, so gating it on hasUI could leave turnRunning stuck true (and
		// block all future re-arming) if a turn ever ends without UI. Arming
		// without UI is harmless — generate() bails on !hasUI and the timer is
		// unref'd, so a one-shot -p process exits before it can fire.
		lastTurnEndAt = Date.now();
		scheduler.turnEnded();
	});

	pi.on("after_provider_response", (event) => {
		rateLimitStatus = responseRateLimitStatus(event.headers);
	});

	// Released after the abort, so a call that finished first keeps no socket (releaseSideCalls).
	pi.on("session_shutdown", (_event, ctx) => {
		scheduler.reset();
		abortInFlight();
		releaseSideCall(ctx.sessionManager.getSessionId(), "recap");
	});
}

export default feature("recap", recapExtension);
