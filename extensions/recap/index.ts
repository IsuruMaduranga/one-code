/**
 * recap extension — Claude Code's "while you were away" summary (the ※ line).
 *
 * CC fires it when the terminal has been blurred for 5 minutes; pi exposes no
 * terminal focus/blur event, so the closest faithful trigger is an idle timer:
 * armed when a turn ends, reset on any keystroke (onTerminalInput) and cleared
 * while a turn runs, it fires after CC's 5-minute lull with no interaction. At
 * most one recap per user turn (firedSinceTurn), matching CC's
 * hasSummarySinceLastUserTurn guard.
 *
 * Generation is Claude Code 2.1.261's: the session's last provider request
 * replayed unchanged on the session model, the reply that answered it, then
 * the verbatim prompt, so the call reads the cache the session wrote and
 * writes the reply for the user's next turn (lib/request-replay.ts; the
 * compaction extension publishes the capture). Without a capture for the
 * session model, or on a provider API the replay does not cover, it falls back
 * to a small standalone call on a cheap same-containment model
 * (pickEconomicalContainedModel): the last 30 messages and name-only stubs of
 * the active tools (some providers reject a history carrying tool_use blocks
 * with no tools declared). The result is a display-only entry (appendEntry,
 * not in LLM context). Best-effort throughout: any failure just shows nothing.
 *
 * Deviations from CC, logged in working-docs/decisions: the session-memory block is
 * omitted (decoupling). A failed recap does not retry until the next turn (one
 * attempt per turn, success or not). CC_RECAP=0 opts out; CC_RECAP_IDLE_MS
 * overrides the 5-minute delay.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withReasoningFallback } from "../lib/model-policy.ts";
import { followLastExchange, replaySideCall } from "../lib/replay-call.ts";
import { recordUsage } from "../lib/usage-bus.ts";
import { pickEconomicalContainedModel } from "../lib/model-tier.ts";
import { answerText, stripImageBlocks, toolStubs, withoutSystemMessages } from "../lib/side-call.ts";
import { dimMarkedLine } from "../lib/tui-render.ts";
import { RECAP_PROMPT, recapLine, recentForRecap, REFERENCE_MARK } from "./prompt.ts";
import { RecapScheduler } from "./scheduler.ts";

const ENTRY_TYPE = "one-code:recap";
const DEFAULT_IDLE_MS = 5 * 60_000; // CC's BLUR_DELAY_MS
const RECAP_MAX_TOKENS = 256; // 1-3 short sentences
/** Description on the name-only tool stubs sent with the recap. */
const STUB_REASON = "Unavailable during this summary; answer in text.";
const RECAP_TIMEOUT_MS = 30_000;

/** The idle delay before a recap, overridable via CC_RECAP_IDLE_MS (floor 1s). */
function idleMs(): number {
	const raw = Number(process.env.CC_RECAP_IDLE_MS);
	return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_IDLE_MS;
}

interface RecapData {
	content: string;
}

export default function recapExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<RecapData>(ENTRY_TYPE, (entry, _options, theme) => {
		const content = entry.data?.content;
		if (!content) return undefined;
		return dimMarkedLine(theme, REFERENCE_MARK, recapLine(content));
	});

	// The exact request messages the session last sent (after every extension's
	// mutations), captured like the compaction extension does.
	let capturedMessages: AgentMessage[] | undefined;
	pi.on("context", (event) => {
		capturedMessages = event.messages;
	});
	// The same request as it went on the wire, and the reply that answered it.
	const exchange = followLastExchange(pi);

	let lastCtx: ExtensionContext | undefined;
	let inFlight: AbortController | undefined;
	let inputHookRegistered = false;

	const abortInFlight = () => {
		inFlight?.abort();
		inFlight = undefined;
	};

	const scheduler = new RecapScheduler(
		{
			set: (cb, ms) => {
				const handle = setTimeout(cb, ms);
				handle.unref?.();
				return handle;
			},
			clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
		idleMs,
		() => process.env.CC_RECAP !== "0",
		() => void generate(),
	);

	/** The fallback: a small standalone call on a cheap same-containment model. */
	async function standaloneRecap(ctx: ExtensionContext, model: Model<Api>, messages: AgentMessage[], signal: AbortSignal): Promise<string> {
		const choice = pickEconomicalContainedModel(ctx.modelRegistry.getAvailable(), model);
		if (!choice) return "";
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(choice.model);
		if (!auth.ok) return "";
		const baseUrl = (auth as { baseUrl?: string }).baseUrl;

		// Name-only stubs of the active tools, so a history carrying tool_use
		// blocks stays valid on strict providers (see the header note) without
		// shipping every full schema (~6k tokens) to a call that must answer
		// in text.
		const tools = toolStubs(pi.getActiveTools(), STUB_REASON);

		const recent = recentForRecap(withoutSystemMessages(messages));
		// The cheap reader may be a text-only model, and the recap does not need
		// images — strip them so a pasted image or one a Read returned cannot break
		// the call (working-docs/decisions/model-policy.md).
		const recapMessages = [...stripImageBlocks(convertToLlm(recent)), { role: "user" as const, content: RECAP_PROMPT, timestamp: Date.now() }];
		// Thinking off unless the model cannot disable it; withReasoningFallback
		// sends a level up front for catalog-marked models and retries on the 400
		// for the rest. Fires on a 5-min idle timer, so no cross-call memo.
		const result = await withReasoningFallback(choice.model, (reasoning) => {
			const timeout = AbortSignal.timeout(RECAP_TIMEOUT_MS);
			return completeSimple(
				baseUrl ? ({ ...choice.model, baseUrl } as Model<Api>) : choice.model,
				{ systemPrompt: "", messages: recapMessages, tools },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: AbortSignal.any([signal, timeout]),
					maxTokens: RECAP_MAX_TOKENS,
					...(reasoning ? { reasoning } : {}),
				},
			);
		}, undefined, (usage) => recordUsage(pi, "recap", usage));
		return answerText(result.content);
	}

	async function generate() {
		const ctx = lastCtx;
		const messages = capturedMessages;
		if (!ctx?.hasUI || !messages?.length || scheduler.hasFiredSinceTurn) return;
		abortInFlight();
		const controller = new AbortController();
		inFlight = controller;
		try {
			const model = ctx.model;
			if (!model) return;
			const replayed = await replaySideCall(ctx, model as Model<Api>, exchange, RECAP_PROMPT, {
				signal: controller.signal,
				timeoutMs: RECAP_TIMEOUT_MS,
				onUsage: (usage) => recordUsage(pi, "recap", usage),
			});
			const content = replayed ?? (await standaloneRecap(ctx, model as Model<Api>, messages, controller.signal));
			if (controller.signal.aborted) return;
			if (!content) return;
			scheduler.markFired();
			pi.appendEntry<RecapData>(ENTRY_TYPE, { content });
		} catch {
			// Best-effort: a failed recap shows nothing — and does not retry. Without
			// this the failure re-arms on every keystroke (interacted() → arm()),
			// hammering the provider once per idle period until a turn resets it.
			// An abort means a new turn or session already reset the scheduler; a
			// late markFired there would suppress that turn's own recap.
			if (!controller.signal.aborted) scheduler.markFired();
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		// A new session (including after /clear): drop any timer armed by the
		// previous session and its captured messages, so a stale recap can never
		// surface against the fresh conversation.
		scheduler.reset();
		abortInFlight();
		capturedMessages = undefined;
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
	// configured idle (CC_RECAP_IDLE_MS floors at 1s), burning the
	// one-per-turn budget mid-turn.
	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		// Unconditional: turnEnded() both clears turn state and arms the idle
		// timer, so gating it on hasUI could leave turnRunning stuck true (and
		// block all future re-arming) if a turn ever ends without UI. Arming
		// without UI is harmless — generate() bails on !hasUI and the timer is
		// unref'd, so a one-shot -p process exits before it can fire.
		scheduler.turnEnded();
	});

	pi.on("session_shutdown", () => {
		scheduler.reset();
		abortInFlight();
	});
}
