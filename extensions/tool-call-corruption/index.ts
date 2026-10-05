/** Reject damaged OpenRouter streams before tool execution, without changing the request prefix. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyOrPrint } from "../lib/headless-output.ts";
import { sessionOutlivesTurn } from "../lib/notifications.ts";
import { isOpenRouter, openRouterProviderName, toolCallCorruptionNotice, type UpstreamFailure } from "../lib/openrouter-generation.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { scanToolCallMarkup, TOOL_CALL_MARKUP_LIMIT, toolCallCorruptionReason } from "../lib/tool-call-corruption.ts";
import { withKeepAlive } from "../lsp/keep-alive.ts";

// Silence inside a stream, measured from the response headers (Claude Code's
// watchdog length), and the shorter limit once a tool call is streaming:
// arguments never pause for thinking.
const STREAM_IDLE_MS = 90_000;
const TOOL_CALL_IDLE_MS = 60_000;

export default function toolCallCorruptionExtension(pi: ExtensionAPI) {
	const alive = sessionAlive(pi);
	const rawCalls = new Map<number, { raw: string; markup: number; next: number }>();
	const flagged = new Map<string, string>();
	const pending = new Map<AbortController, Promise<void>>();
	let responseId: string | undefined;
	// OpenRouter names the serving provider on every chunk; a cancelled
	// generation is never recorded, so the lookup cannot name it after a stop.
	let streamProvider: string | undefined;
	let stopped = false;
	let toolCallStreaming = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const clearIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const resetMessage = () => {
		rawCalls.clear();
		flagged.clear();
		responseId = undefined;
		streamProvider = undefined;
		toolCallStreaming = false;
		clearIdle();
	};
	const resetRun = () => {
		resetMessage();
		stopped = false;
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
		ctx.abort();
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
	const armIdle = (ctx: ExtensionContext) => {
		clearIdle();
		if (stopped) return;
		const ms = toolCallStreaming ? TOOL_CALL_IDLE_MS : STREAM_IDLE_MS;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			stopTurn(ctx, { stalledSeconds: ms / 1000 });
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
	});

	pi.on("message_update", (event, ctx) => {
		if (!alive() || !isOpenRouter(ctx.model)) return;
		const update = event.assistantMessageEvent;
		if (!("partial" in update)) return;
		responseId = update.partial.responseId || responseId;
		switch (update.type) {
			case "toolcall_start":
				rawCalls.set(update.contentIndex, { raw: "", markup: 0, next: 0 });
				toolCallStreaming = true;
				break;
			case "toolcall_delta": {
				const call = rawCalls.get(update.contentIndex) ?? { raw: "", markup: 0, next: 0 };
				call.raw += update.delta;
				const scan = scanToolCallMarkup(call.raw, call.next);
				call.markup += scan.count;
				call.next = scan.next;
				rawCalls.set(update.contentIndex, call);
				// A leaked call can stream markup without end and never reach toolcall_end.
				if (call.markup >= TOOL_CALL_MARKUP_LIMIT) return stopTurn(ctx, "corrupt-stream");
				break;
			}
			case "toolcall_end": {
				const raw = rawCalls.get(update.contentIndex)?.raw;
				rawCalls.delete(update.contentIndex);
				if (raw === undefined) break;
				const reason = toolCallCorruptionReason(update.toolCall.name, raw);
				if (reason) flagged.set(update.toolCall.id, `OpenRouter tool-call corruption: ${reason} Do not retry this call; switch models or exclude the upstream provider.`);
				break;
			}
		}
		armIdle(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") clearIdle();
		if (alive() && isOpenRouter(ctx.model) && event.message.role === "assistant") {
			responseId = event.message.responseId || responseId;
			// A reply cut off at the token limit ends mid-call: the damage is the
			// limit's, not the provider's.
			if (event.message.stopReason === "length") flagged.clear();
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (!alive() || !isOpenRouter(ctx.model)) return;
		const reason = flagged.get(event.toolCallId);
		if (reason) return { block: true, reason, terminate: true };
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (!alive() || stopped || !isOpenRouter(ctx.model) || !flagged.has(event.toolCallId)) return;
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
