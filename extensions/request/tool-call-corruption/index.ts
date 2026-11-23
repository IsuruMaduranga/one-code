/**
 * Reject damaged OpenRouter streams before tool execution, without changing the request prefix.
 * It also publishes the host that served each main-session reply, which it reads from the stream anyway, for /doctor,
 * and explains a main-session refusal caused by the profile's quantization floor (lib/request/openrouter-routing-defaults.ts).
 * With the host and each reply's usage it also names a host that keeps missing the prompt cache (lib/request/openrouter-cache-watch.ts).
 */
import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyOrPrint } from "../../lib/notify/headless-output.ts";
import { TURN_FAILED_CHANNEL, type TurnFailedEvent } from "../../lib/notify/interrupt.ts";
import { sessionOutlivesTurn } from "../../lib/notify/notifications.ts";
import { isOpenRouter, toolCallCorruptionNotice, type UpstreamFailure } from "./openrouter-generation.ts";
import { openRouterProviderName } from "../../lib/request/openrouter-generation.ts";
import { sessionAlive } from "../../lib/notify/session-lifecycle.ts";
import {
	CONTENT_MARKUP_LIMIT,
	RUNAWAY_PADDING_LIMIT,
	scanToolCallMarkup,
	TOOL_CALL_MARKUP_LIMIT,
	type ToolCallDamage,
	type TrailingPadding,
	toolCallCorruptionReason,
	trailingPadding,
} from "./tool-call-corruption.ts";
import { withKeepAlive } from "../../lib/core/keep-alive.ts";
import { repeatLimit, type RepeatTail, trailingRepeat } from "./repeat.ts";
import { OPENROUTER_HOST_CHANNEL, type OpenRouterHostEvent } from "../../lib/request/openrouter-host.ts";
import { cacheMissNotice, createCacheWatch } from "../../lib/request/openrouter-cache-watch.ts";
import { activeOpenRouterRouting, routingFloorFailureHint } from "../../lib/request/openrouter-routing-defaults.ts";
import { toolCallCorruptionText } from "./text.ts";

// Silence allowed inside an OpenRouter stream. Every raw chunk restarts the
// clock, but OpenRouter's keepalive comments never reach us, so a model
// thinking server-side before its first token looks silent: that wait is long.
// After the first content it is 90 s, and 60 s while a tool call's arguments
// stream (arguments never pause for thinking).
const FIRST_CONTENT_IDLE_MS = 300_000;
const STREAM_IDLE_MS = 90_000;
const TOOL_CALL_IDLE_MS = 60_000;

function toolCallCorruptionExtension(pi: ExtensionAPI) {
	toolCallCorruptionGuard(pi, { announce: true });
}

/**
 * The guard itself. `announce: false` is the in-process child's shape
 * (`child.ts`): it blocks and stops the same way, but a child has no terminal
 * of its own (stderr is the parent's TUI) and is disposed without
 * `session_shutdown`, so it prints nothing and starts no provider lookup that
 * could outlive it. Its parent sees the child's turn end terminated.
 */
export function toolCallCorruptionGuard(pi: ExtensionAPI, { announce }: { announce: boolean }) {
	const alive = sessionAlive(pi);
	const rawCalls = new Map<number, { raw: string; markup: number; contentMarkup: number; next: number }>();
	const flagged = new Map<string, ToolCallDamage>();
	// Any provider: a call streaming blank padding without end never reaches
	// toolcall_end, and nothing else stops it (gpt-6.1-sol, battery round 7:
	// 26 MB of tabs and newlines over 25 minutes in a one-shot run).
	const padding = new Map<number, TrailingPadding>();
	// Any provider: a call whose arguments end in one unit repeated without end
	// (GPT-6.1 Terra: "Lspnull " for 43 KB over six minutes in a subagent;
	// findings §94). Every chunk looks like progress, so no idle clock sees it.
	const repeats = new Map<number, RepeatTail>();
	const pending = new Map<AbortController, Promise<void>>();
	let responseId: string | undefined;
	// OpenRouter names the serving provider on every chunk; a cancelled
	// generation is never recorded, so the lookup cannot name it after a stop.
	let streamProvider: string | undefined;
	let cacheWatch = createCacheWatch();
	let stopped = false;
	// A suspect call goes back to the model once per run; the next one is corrupt.
	let suspectReturned = false;
	let contentStarted = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let idleMs = 0;

	const clearIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const resetMessage = () => {
		rawCalls.clear();
		flagged.clear();
		padding.clear();
		repeats.clear();
		responseId = undefined;
		streamProvider = undefined;
		contentStarted = false;
		clearIdle();
	};
	const resetRun = () => {
		resetMessage();
		stopped = false;
		suspectReturned = false;
	};
	const cancelLookups = () => {
		for (const controller of pending.keys()) controller.abort();
		pending.clear();
	};

	/** Abort the turn once and tell the user which upstream provider failed. */
	const stopTurn = (ctx: ExtensionContext, failure: UpstreamFailure) => {
		if (stopped || !alive()) return;
		stopped = true;
		clearIdle();
		const what = typeof failure === "object" ? `stalled ${failure.stalledSeconds} s` : failure;
		pi.events.emit(TURN_FAILED_CHANNEL, { reason: `OpenRouter upstream failure: ${what}` } satisfies TurnFailedEvent);
		ctx.abort();
		if (!announce) return;
		const model = ctx.model!;
		const registry = ctx.modelRegistry;
		const output = { hasUI: ctx.hasUI, ui: ctx.ui };
		const controller = new AbortController();
		const named = streamProvider;
		const notice = withKeepAlive(async () => {
			const provider = named ?? await openRouterProviderName(responseId, async () => {
				const auth = await registry.getApiKeyAndHeaders(model);
				return auth.ok ? { apiKey: auth.apiKey, baseUrl: auth.baseUrl ?? model.baseUrl } : undefined;
			}, controller.signal);
			if (alive() && !controller.signal.aborted) notifyOrPrint(output, toolCallCorruptionNotice(model.id, provider, failure), "error");
		}).finally(() => pending.delete(controller));
		pending.set(controller, notice);
	};
	/** (Re)start the silence clock; a call still streaming arguments keeps the short window. */
	const armIdle = (ctx: ExtensionContext) => {
		if (stopped) return clearIdle();
		const ms = rawCalls.size > 0 ? TOOL_CALL_IDLE_MS : contentStarted ? STREAM_IDLE_MS : FIRST_CONTENT_IDLE_MS;
		if (idleTimer && ms === idleMs) {
			idleTimer.refresh();
			return;
		}
		clearIdle();
		idleMs = ms;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			try {
				stopTurn(ctx, { stalledSeconds: ms / 1000 });
			} catch {
				// A child session disposed mid-stream (no session_shutdown): its ctx throws, and there is nothing left to stop.
			}
		}, ms);
		idleTimer.unref?.();
	};

	pi.on("session_start", () => {
		cancelLookups();
		resetRun();
		cacheWatch = createCacheWatch();
	});
	pi.on("session_shutdown", () => {
		cancelLookups();
		resetRun();
	});
	pi.on("agent_start", resetRun);
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		resetMessage();
		if (alive() && isOpenRouter(ctx.model)) armIdle(ctx);
	});

	pi.on("provider_stream_event", (event, ctx) => {
		if (!alive() || !isOpenRouter(ctx.model)) return;
		const provider = (event.data as { provider?: unknown } | null)?.provider;
		if (typeof provider === "string" && provider.trim()) streamProvider = provider.trim();
		// Any chunk is a sign of life, content or not (reasoning details, usage, an empty delta).
		if (idleTimer) armIdle(ctx);
	});

	/** Stop a turn whose tool call ran away, once, saying why (the parent of a child reads the reason as the agent's failure). */
	const stopRunaway = (ctx: ExtensionContext, reason: string) => {
		stopped = true;
		clearIdle();
		pi.events.emit(TURN_FAILED_CHANNEL, { reason } satisfies TurnFailedEvent);
		ctx.abort();
		if (announce) notifyOrPrint({ hasUI: ctx.hasUI, ui: ctx.ui }, `${reason} Send the request again, or switch models if it repeats.`, "error");
	};

	pi.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent;
		if (!alive() || stopped || update.type !== "toolcall_delta") return;
		const state = trailingPadding(padding.get(update.contentIndex), update.delta);
		padding.set(update.contentIndex, state);
		if (state.structural && state.run >= RUNAWAY_PADDING_LIMIT) {
			return stopRunaway(
				ctx,
				`The model streamed over ${RUNAWAY_PADDING_LIMIT.toLocaleString("en-US")} characters of blank space into a tool call's arguments without finishing it, so the turn was stopped.`,
			);
		}
		const call = update.partial.content[update.contentIndex];
		const tool = call?.type === "toolCall" ? call.name : undefined;
		const limit = repeatLimit(tool);
		const repeat = trailingRepeat(repeats.get(update.contentIndex), update.delta, limit);
		repeats.set(update.contentIndex, repeat.state);
		if (repeat.unit === undefined) return;
		stopRunaway(ctx, toolCallCorruptionText.runawayRepeat({ tool: tool ?? "tool", unit: repeat.unit, chars: repeat.chars ?? limit }));
	});

	pi.on("message_update", (event, ctx) => {
		if (!alive() || !isOpenRouter(ctx.model)) return;
		const update = event.assistantMessageEvent;
		if (!("partial" in update)) return;
		responseId = update.partial.responseId || responseId;
		contentStarted = true;
		switch (update.type) {
			case "toolcall_start":
				rawCalls.set(update.contentIndex, { raw: "", markup: 0, contentMarkup: 0, next: 0 });
				break;
			case "toolcall_delta": {
				const call = rawCalls.get(update.contentIndex) ?? { raw: "", markup: 0, contentMarkup: 0, next: 0 };
				call.raw += update.delta;
				const scan = scanToolCallMarkup(call.raw, call.next);
				call.markup += scan.count;
				call.contentMarkup += scan.contentCount;
				call.next = scan.next;
				rawCalls.set(update.contentIndex, call);
				// A leaked call can stream markup without end and never reach toolcall_end.
				if (call.markup >= TOOL_CALL_MARKUP_LIMIT || call.contentMarkup >= CONTENT_MARKUP_LIMIT) return stopTurn(ctx, "corrupt-stream");
				break;
			}
			case "toolcall_end": {
				const raw = rawCalls.get(update.contentIndex)?.raw;
				rawCalls.delete(update.contentIndex);
				if (raw === undefined) break;
				const damage = toolCallCorruptionReason(update.toolCall.name, raw);
				if (damage) flagged.set(update.toolCall.id, damage);
				break;
			}
		}
		armIdle(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") clearIdle();
		if (alive() && isOpenRouter(ctx.model) && event.message.role === "assistant") {
			responseId = event.message.responseId || responseId;
			// A reply cut off at the token limit ends mid-call: the damage to its
			// last block is the limit's, not the provider's. A call completed
			// before it was judged whole and stays blocked.
			const last = event.message.stopReason === "length" ? event.message.content.at(-1) : undefined;
			if (last?.type === "toolCall") flagged.delete(last.id);
			// A floor that left the model no host fails every request with OpenRouter's bare refusal: say why, once per reply.
			const floorHint = announce && event.message.stopReason === "error" ? routingFloorFailureHint(ctx.model!, event.message.errorMessage, activeOpenRouterRouting()) : undefined;
			if (floorHint) notifyOrPrint({ hasUI: ctx.hasUI, ui: ctx.ui }, floorHint, "error");
			// The main session's host, for /doctor (lib/request/openrouter-host.ts); a child has its own bus and no report.
			if (announce && (streamProvider || responseId)) {
				const model = ctx.model!;
				pi.events.emit(OPENROUTER_HOST_CHANNEL, { model: `${model.provider}/${model.id}`, host: streamProvider, responseId } satisfies OpenRouterHostEvent);
			}
			// A host that keeps missing the cache: name it once, with how to skip it.
			const usage = event.message.usage;
			if (announce && streamProvider && usage && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
				const model = ctx.model!;
				const streak = cacheWatch.observe({ model: `${model.provider}/${model.id}`, host: streamProvider, input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
				if (streak) notifyOrPrint({ hasUI: ctx.hasUI, ui: ctx.ui }, cacheMissNotice(streak, (model.cost?.input ?? 0) - (model.cost?.cacheRead ?? 0)), "warning");
			}
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (!alive() || !isOpenRouter(ctx.model)) return;
		const damage = flagged.get(event.toolCallId);
		if (!damage) return;
		if (damage.kind === "suspect" && !suspectReturned) {
			suspectReturned = true;
			flagged.delete(event.toolCallId);
			return { block: true, reason: toolCallCorruptionText.suspectBlock({ reason: damage.reason }) };
		}
		const repeat = damage.kind === "suspect";
		flagged.set(event.toolCallId, { kind: "corrupt", reason: damage.reason });
		return {
			block: true,
			reason: toolCallCorruptionText.corruptBlock({ reason: damage.reason, repeat }),
			terminate: true,
		};
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (!alive() || stopped || !isOpenRouter(ctx.model) || flagged.get(event.toolCallId)?.kind !== "corrupt") return;
		// Aborting inside tool_call would replace our reason with "Operation aborted".
		// This also catches schema-validation failures, which bypass tool_call entirely.
		stopTurn(ctx, "blocked-call");
	});
	pi.on("agent_end", async (_event, ctx) => {
		clearIdle();
		// Print/JSON dispose the session immediately after agent_end. The turn is
		// already aborted; flush its bounded diagnostic before one-shot teardown.
		if (!sessionOutlivesTurn(ctx.mode)) await Promise.all(pending.values());
	});
}

export default feature("tool-call-corruption", toolCallCorruptionExtension);
