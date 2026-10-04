/** Reject damaged OpenRouter streams before tool execution, without changing the request prefix. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyOrPrint } from "../lib/headless-output.ts";
import { sessionOutlivesTurn } from "../lib/notifications.ts";
import { isOpenRouter, openRouterProviderName, toolCallCorruptionNotice } from "../lib/openrouter-generation.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { toolCallCorruptionReason } from "../lib/tool-call-corruption.ts";
import { withKeepAlive } from "../lsp/keep-alive.ts";

export default function toolCallCorruptionExtension(pi: ExtensionAPI) {
	const alive = sessionAlive(pi);
	const rawCalls = new Map<number, string>();
	const flagged = new Map<string, string>();
	const pending = new Map<AbortController, Promise<void>>();
	let responseId: string | undefined;
	let stopped = false;

	const resetMessage = () => {
		rawCalls.clear();
		flagged.clear();
		responseId = undefined;
	};
	const resetRun = () => {
		resetMessage();
		stopped = false;
	};
	const cancelLookups = () => {
		for (const controller of pending.keys()) controller.abort();
		pending.clear();
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
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") resetMessage();
	});

	pi.on("message_update", (event, ctx) => {
		if (!alive() || !isOpenRouter(ctx.model)) return;
		const update = event.assistantMessageEvent;
		if (!("partial" in update)) return;
		responseId = update.partial.responseId || responseId;
		switch (update.type) {
			case "toolcall_start":
				rawCalls.set(update.contentIndex, "");
				break;
			case "toolcall_delta":
				rawCalls.set(update.contentIndex, (rawCalls.get(update.contentIndex) ?? "") + update.delta);
				break;
			case "toolcall_end": {
				const raw = rawCalls.get(update.contentIndex);
				rawCalls.delete(update.contentIndex);
				if (raw === undefined) break;
				const reason = toolCallCorruptionReason(update.toolCall.name, raw);
				if (reason) flagged.set(update.toolCall.id, `OpenRouter tool-call corruption: ${reason} Do not retry this call; switch models or exclude the upstream provider.`);
				break;
			}
		}
	});
	pi.on("message_end", (event, ctx) => {
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
		stopped = true;
		// Aborting inside tool_call would replace our reason with "Operation aborted".
		// This also catches schema-validation failures, which bypass tool_call entirely.
		ctx.abort();
		const model = ctx.model!;
		const registry = ctx.modelRegistry;
		const output = { hasUI: ctx.hasUI, ui: ctx.ui };
		const controller = new AbortController();
		const notice = withKeepAlive(async () => {
			const provider = await openRouterProviderName(responseId, async () => {
				const auth = await registry.getApiKeyAndHeaders(model);
				return auth.ok ? auth.apiKey : undefined;
			}, controller.signal);
			if (alive() && !controller.signal.aborted) notifyOrPrint(output, toolCallCorruptionNotice(model.id, provider), "error");
		}).finally(() => pending.delete(controller));
		pending.set(controller, notice);
	});
	pi.on("agent_end", async (_event, ctx) => {
		// Print/JSON dispose the session immediately after agent_end. The turn is
		// already aborted; flush its bounded diagnostic before one-shot teardown.
		if (!sessionOutlivesTurn(ctx.mode)) await Promise.all(pending.values());
	});
}
