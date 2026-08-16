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
 * Generation mirrors CC's awaySummary.ts: a cheap same-containment model
 * (pickEconomicalContainedModel — the getSmallFastModel analog), CC's verbatim
 * prompt, and only the last 30 messages. It deliberately does NOT reuse the
 * session prompt cache the way compaction does — CC makes a small standalone
 * call here (skipCacheWrite). The result is a display-only entry (appendEntry,
 * not in LLM context). Best-effort throughout: any failure just shows nothing.
 *
 * Deviations from CC, logged in docs/decisions: the session-memory block is
 * omitted (decoupling), and the active tool definitions are sent rather than
 * an empty tool list — some providers reject a history carrying tool_use
 * blocks with no tools declared, and the small-token instruction keeps the
 * model answering in text rather than calling one. CC_RECAP=0 opts out;
 * CC_RECAP_IDLE_MS overrides the 5-minute delay.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickEconomicalContainedModel } from "../lib/model-policy.ts";
import { dimMarkedLine } from "../lib/tui-render.ts";
import { RECAP_PROMPT, recapLine, recentForRecap, REFERENCE_MARK } from "./prompt.ts";
import { RecapScheduler } from "./scheduler.ts";

const ENTRY_TYPE = "one-code:recap";
const DEFAULT_IDLE_MS = 5 * 60_000; // CC's BLUR_DELAY_MS
const RECAP_MAX_TOKENS = 256; // 1-3 short sentences
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
			const choice = pickEconomicalContainedModel(ctx.modelRegistry.getAvailable(), model);
			if (!choice) return;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(choice.model);
			if (!auth.ok) return;
			const baseUrl = (auth as { baseUrl?: string }).baseUrl;

			// The active tool definitions, so a history carrying tool_use blocks
			// stays valid on strict providers (see the header note).
			const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			const tools = pi
				.getActiveTools()
				.map((name) => byName.get(name))
				.filter((tool) => tool !== undefined)
				.map(({ name, description, parameters }) => ({ name, description, parameters }) as Tool);

			const recent = recentForRecap(messages);
			const timeout = AbortSignal.timeout(RECAP_TIMEOUT_MS);
			const result = await completeSimple(
				baseUrl ? ({ ...choice.model, baseUrl } as Model<Api>) : choice.model,
				{
					systemPrompt: "",
					messages: [...convertToLlm(recent), { role: "user", content: RECAP_PROMPT, timestamp: Date.now() }],
					tools,
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: AbortSignal.any([controller.signal, timeout]),
					maxTokens: RECAP_MAX_TOKENS,
				},
			);
			if (controller.signal.aborted) return;
			const content = result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (!content) return;
			scheduler.markFired();
			pi.appendEntry<RecapData>(ENTRY_TYPE, { content });
		} catch {
			// Best-effort: a failed/aborted recap call simply shows nothing.
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

	pi.on("agent_end", (_event, ctx) => {
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
