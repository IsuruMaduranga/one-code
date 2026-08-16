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
import { linesComponent, safeThemePaint } from "../lib/tui-render.ts";
import { RECAP_PROMPT, RECENT_MESSAGE_WINDOW, recapLine, REFERENCE_MARK } from "./prompt.ts";

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
		const paint = safeThemePaint(theme);
		const line = `${paint("dim", REFERENCE_MARK)} ${paint("dim", recapLine(content))}`;
		return linesComponent(() => [line]);
	});

	// The exact request messages the session last sent (after every extension's
	// mutations), captured like the compaction extension does.
	let capturedMessages: AgentMessage[] | undefined;
	pi.on("context", (event) => {
		capturedMessages = event.messages;
	});

	let lastCtx: ExtensionContext | undefined;
	let turnRunning = false;
	let firedSinceTurn = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: AbortController | undefined;

	const clearTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	const abortInFlight = () => {
		inFlight?.abort();
		inFlight = undefined;
	};
	const arm = () => {
		clearTimer();
		if (turnRunning || firedSinceTurn || process.env.CC_RECAP === "0") return;
		timer = setTimeout(() => void generate(), idleMs());
		timer.unref?.();
	};

	async function generate() {
		const ctx = lastCtx;
		const messages = capturedMessages;
		if (!ctx?.hasUI || !messages?.length || firedSinceTurn) return;
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

			const recent = messages.slice(-RECENT_MESSAGE_WINDOW);
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
			firedSinceTurn = true;
			pi.appendEntry<RecapData>(ENTRY_TYPE, { content });
		} catch {
			// Best-effort: a failed/aborted recap call simply shows nothing.
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		// Reset the idle clock on any keystroke — the closest signal to CC's
		// terminal-blur trigger pi exposes. Registered once; acts through the
		// freshest ctx via lastCtx (session switches replace the context).
		ctx.ui.onTerminalInput(() => {
			if (!turnRunning) arm();
			return undefined; // observe only; never consume the keystroke
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		turnRunning = true;
		firedSinceTurn = false;
		clearTimer();
		abortInFlight();
	});

	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
		turnRunning = false;
		if (!ctx.hasUI) return;
		arm();
	});

	pi.on("session_shutdown", () => {
		clearTimer();
		abortInFlight();
	});
}
