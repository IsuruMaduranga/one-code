/**
 * idle-compact extension — Claude Code's compaction of an idle session before
 * its one-hour prompt cache expires (rules and refusal order: policy.ts).
 *
 * Wiring: the timer follows the compaction extension's capture of the
 * session's last request (`LAST_REQUEST_CHANNEL`), the very request its
 * cache-reading replay sends. Each capture re-arms it when the body caches for
 * one hour (`hasOneHourCache`); a cleared capture (a new session, a compaction,
 * a branch switch) drops it, so the timer is armed only while a replay is
 * possible. The reply's usage says whether the cache was warm, the response
 * headers carry Anthropic's rate-limit status, and keystrokes
 * (`onTerminalInput`) mark the user present.
 *
 * TUI only: RPC mode also runs the one-hour cache, but its host's input never
 * reaches `onTerminalInput`, so the presence check could not hold a
 * compaction off while someone is there.
 *
 * On fire it calls `ctx.compact()`; pi's TUI shows its usual "Compacting"
 * indicator, Esc cancels, and on success a display-only entry carries Claude
 * Code's notice. Failures are silent, as in Claude Code.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { hasOneHourCache } from "../lib/anthropic-payload.ts";
import { modelSpec } from "../lib/model-policy.ts";
import { LAST_REQUEST_CHANNEL, type RequestCapture } from "../lib/request-replay.ts";
import { unrefTimers } from "../lib/timer-ops.ts";
import { dimMarkedLine, liveUiCtx } from "../lib/tui-render.ts";
import { type ArmedRequest, IDLE_COMPACT_NOTICE, IdleCompactTimer, type IdleCompactConfig, idleCompactConfig, idleRefusal } from "./policy.ts";

const ENTRY_TYPE = "one-code:idle-compact";
const NOTICE_MARK = "●";
const RATE_LIMIT_HEADER = "anthropic-ratelimit-unified-status";

/** pi's auto-compaction setting; unreadable settings mean pi's default, on. */
function autoCompactionOn(cwd: string): boolean {
	try {
		return SettingsManager.create(cwd, getAgentDir()).getCompactionEnabled();
	} catch {
		return true;
	}
}

export default function idleCompactExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer(ENTRY_TYPE, (_entry, _options, theme) => dimMarkedLine(theme, NOTICE_MARK, IDLE_COMPACT_NOTICE));

	let sessionCtx: ExtensionContext | undefined;
	let warm = false;
	let rateLimitStatus: string | undefined;
	let lastInteractionAt: number | undefined;
	let inputHookRegistered = false;

	const timer = new IdleCompactTimer(unrefTimers, Date.now, () => idleCompactConfig(process.env), (armed, dueAt, config) => fire(armed, dueAt, config));

	function fire(armed: ArmedRequest, dueAt: number, config: IdleCompactConfig) {
		const ctx = liveUiCtx(sessionCtx);
		if (!ctx) return;
		const refusal = idleRefusal(armed, {
			now: Date.now(),
			dueAt,
			config,
			compactionOn: process.env.CC_COMPACTION !== "0" && autoCompactionOn(ctx.cwd),
			model: ctx.model ? modelSpec(ctx.model) : undefined,
			thinking: pi.getThinkingLevel(),
			warm,
			contextTokens: ctx.getContextUsage()?.tokens ?? 0,
			rateLimitStatus,
			idle: ctx.isIdle() && !ctx.hasPendingMessages(),
			lastInteractionAt,
		});
		if (refusal !== null) return;
		ctx.compact({
			onComplete: () => pi.appendEntry(ENTRY_TYPE),
			// Claude Code logs a failed idle compaction and shows nothing; pi's TUI
			// still reports an error or an Esc cancel, as for any compaction.
			onError: () => {},
		});
	}

	pi.events.on(LAST_REQUEST_CHANNEL, (data) => {
		const capture = data as RequestCapture | undefined;
		const ctx = liveUiCtx(sessionCtx);
		warm = false;
		if (!capture || ctx?.mode !== "tui" || !hasOneHourCache(capture.payload)) {
			timer.cancel();
			return;
		}
		timer.arm({ at: Date.now(), model: modelSpec({ provider: capture.provider, id: capture.modelId }), thinking: pi.getThinkingLevel() });
	});

	pi.on("after_provider_response", (event) => {
		if (!timer.pending) return;
		const entry = Object.entries(event.headers ?? {}).find(([name]) => name.toLowerCase() === RATE_LIMIT_HEADER);
		rateLimitStatus = entry?.[1];
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; usage?: { cacheRead?: number; cacheWrite?: number } };
		if (message.role === "assistant") warm = (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0) > 0;
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		rateLimitStatus = undefined;
		lastInteractionAt = undefined;
		if (!ctx.hasUI || inputHookRegistered) return;
		// Registered once: session_start fires again on every /clear and switch.
		inputHookRegistered = true;
		ctx.ui.onTerminalInput(() => {
			lastInteractionAt = Date.now();
			return undefined; // observe only
		});
	});

	pi.on("session_shutdown", () => {
		timer.cancel();
		sessionCtx = undefined;
	});
}
