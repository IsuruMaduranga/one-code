/**
 * idle-compact extension — Claude Code's compaction of an idle session before
 * its one-hour prompt cache expires (rules and refusal order: policy.ts).
 *
 * Wiring: every main-session request (`before_provider_request`, TUI only, the
 * mode that runs the one-hour cache) re-arms the timer from its body's cache
 * TTL; the reply's usage says whether the cache was warm; the response headers
 * carry Anthropic's rate-limit status; keystrokes (`onTerminalInput`) mark the
 * user present. A new session, a compaction, a branch switch and shutdown drop
 * the timer, since the compaction extension's capture of the last request,
 * which its cache-reading replay needs, is dropped with them.
 *
 * On fire it calls `ctx.compact()`, which runs One Code's compaction (the
 * replay of the session's last request, a cache read); pi's TUI shows its usual
 * "Compacting" indicator, Esc cancels, and on success a display-only entry
 * carries Claude Code's notice. Failures are silent, as in Claude Code.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { dimMarkedLine } from "../lib/tui-render.ts";
import { type ArmedRequest, IDLE_COMPACT_NOTICE, IdleCompactTimer, idleCompactConfig, idleRefusal, ONE_HOUR_MS, requestCacheTtl } from "./policy.ts";

const ENTRY_TYPE = "one-code:idle-compact";
const NOTICE_MARK = "●";
const RATE_LIMIT_HEADER = "anthropic-ratelimit-unified-status";

/** A model's identity for matching the armed request to the current model. */
const modelKey = (model: { provider?: string; id?: string } | undefined) => (model ? `${model.provider}/${model.id}` : undefined);

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

	let lastCtx: ExtensionContext | undefined;
	let lastRequestAt = 0;
	let warm = false;
	let rateLimitStatus: string | undefined;
	let lastInteractionAt: number | undefined;
	let inputHookRegistered = false;

	const timer = new IdleCompactTimer(
		{
			set: (cb, ms) => {
				const handle = setTimeout(cb, ms);
				handle.unref?.();
				return handle;
			},
			clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
		Date.now,
		() => idleCompactConfig(process.env),
		(armed, dueAt) => fire(armed, dueAt),
	);

	function fire(armed: ArmedRequest, dueAt: number) {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		const refusal = idleRefusal(armed, {
			now: Date.now(),
			dueAt,
			config: idleCompactConfig(process.env),
			compactionOn: process.env.CC_COMPACTION !== "0" && autoCompactionOn(ctx.cwd),
			model: modelKey(ctx.model),
			thinking: pi.getThinkingLevel(),
			warm,
			contextTokens: ctx.getContextUsage()?.tokens ?? 0,
			lastRequestAt,
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

	const drop = () => timer.cancel();

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		drop();
		lastRequestAt = 0;
		warm = false;
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

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
		lastCtx = ctx;
		const at = Date.now();
		lastRequestAt = at;
		warm = false;
		const ttl = requestCacheTtl(event.payload);
		timer.noteRequest({ at, ttlMs: ttl === "1h" ? ONE_HOUR_MS : 5 * 60_000, model: modelKey(ctx.model), thinking: pi.getThinkingLevel() });
		return undefined;
	});

	pi.on("after_provider_response", (event) => {
		const entry = Object.entries(event.headers ?? {}).find(([name]) => name.toLowerCase() === RATE_LIMIT_HEADER);
		rateLimitStatus = entry?.[1];
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; usage?: { cacheRead?: number; cacheWrite?: number } };
		if (message.role !== "assistant" || !timer.pending) return;
		warm = (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0) > 0;
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("session_compact", drop);
	pi.on("session_tree", drop);
	pi.on("session_shutdown", drop);
}
