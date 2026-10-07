/** Reject damaged OpenRouter streams before tool execution, without changing the request prefix. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyOrPrint } from "../lib/headless-output.ts";
import { TURN_FAILED_CHANNEL, type TurnFailedEvent } from "../lib/interrupt.ts";
import { sessionOutlivesTurn } from "../lib/notifications.ts";
import { isOpenRouter, openRouterProviderName, toolCallCorruptionNotice, type UpstreamFailure } from "../lib/openrouter-generation.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { CONTENT_MARKUP_LIMIT, scanToolCallMarkup, TOOL_CALL_MARKUP_LIMIT, type ToolCallDamage, toolCallCorruptionReason } from "../lib/tool-call-corruption.ts";
import { withKeepAlive } from "../lsp/keep-alive.ts";

// Silence allowed inside a stream. Every raw chunk restarts the clock, but
// OpenRouter's keepalive comments never reach us, so a model thinking
// server-side before its first token looks silent: that wait is long. After
// the first content it is Claude Code's 90 s watchdog, and 60 s while a tool
// call's arguments stream (arguments never pause for thinking).
const FIRST_CONTENT_IDLE_MS = 300_000;
const STREAM_IDLE_MS = 90_000;
const TOOL_CALL_IDLE_MS = 60_000;

export default function toolCallCorruptionExtension(pi: ExtensionAPI) {
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
	const pending = new Map<AbortController, Promise<void>>();
	let responseId: string | undefined;
	// OpenRouter names the serving provider on every chunk; a cancelled
	// generation is never recorded, so the lookup cannot name it after a stop.
	let streamProvider: string | undefined;
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
				return auth.ok ? auth.apiKey : undefined;
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
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (!alive() || !isOpenRouter(ctx.model)) return;
		const damage = flagged.get(event.toolCallId);
		if (!damage) return;
		if (damage.kind === "suspect" && !suspectReturned) {
			suspectReturned = true;
			flagged.delete(event.toolCallId);
			return { block: true, reason: `${damage.reason} It was not run. Send the complete command again; if it really ends there, drop the trailing blank or the empty option.` };
		}
		const repeat = damage.kind === "suspect" ? " An earlier command in this run came through cut the same way." : "";
		flagged.set(event.toolCallId, { kind: "corrupt", reason: damage.reason });
		return {
			block: true,
			reason: `OpenRouter tool-call corruption: ${damage.reason}${repeat} Do not retry this call; switch models or exclude the upstream provider.`,
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
