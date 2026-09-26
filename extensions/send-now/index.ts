/**
 * send-now extension — Claude Code's "send now" for messages queued mid-turn.
 *
 * A message typed while a turn runs waits in pi's queue until the current
 * response and its tool calls finish. `ctrl+x ctrl+s` (chord.ts) delivers it
 * at once: the running turn is aborted, which makes pi move every queued
 * message and the draft back into the editor (its abort handler), and once the
 * session is idle that text is sent as the next prompt. Running tools are
 * cancelled, as in Claude Code before 2.1.283, which moves them to the
 * background instead. A dim `ctrl+x ctrl+s to send now` line sits above the
 * editor while anything is queued.
 *
 * pi binds `ctrl+x` alone to copy, so a `ctrl+x` is held only while send now
 * applies and replayed through the TUI's input path when the chord does not
 * complete (another key, or CHORD_TIMEOUT_MS without one).
 *
 * pi exposes no read of its queue to extensions, only `hasPendingMessages()`,
 * so the hint asks on every render rather than tracking queue events (a
 * dequeue with alt+up fires none). TUI only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SEND_NOW_CHANNEL } from "../lib/send-now-channel.ts";
import { safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { SEND_NOW_HINT, SendNowChord } from "./chord.ts";

/** How long send now waits for the aborted turn to settle before giving up. */
const IDLE_WAIT_MS = 10_000;
/** How long a held `ctrl+x` waits for its `ctrl+s` before it is replayed as itself. */
const CHORD_TIMEOUT_MS = 1_000;

export default function sendNowExtension(pi: ExtensionAPI) {
	let unsubscribe: (() => void) | undefined;
	// Bumped on every session start and shutdown, so a send now still waiting
	// for the aborted turn never acts on a replaced or closed session.
	let epoch = 0;
	/** Resolves a send now waiting for the aborted turn to settle. */
	let onSettled: (() => void) | undefined;
	const wakeSettled = () => {
		const wake = onSettled;
		onSettled = undefined;
		wake?.();
	};
	pi.on("agent_settled", wakeSettled);

	pi.on("session_shutdown", () => {
		epoch++;
		wakeSettled();
		unsubscribe?.();
		unsubscribe = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		const session = ++epoch;
		const current = () => epoch === session;
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		const queued = () => !ctx.isIdle() && ctx.hasPendingMessages();
		// Claude Code sends the draft too, so a draft alone is enough to send now.
		const active = () => !ctx.isIdle() && (ctx.hasPendingMessages() || ctx.ui.getEditorText().trim() !== "");

		let sending = false;
		const sendNow = async (turnCtx: ExtensionContext) => {
			if (sending) return;
			sending = true;
			try {
				pi.events.emit(SEND_NOW_CHANNEL, {});
				turnCtx.abort();
				if (!turnCtx.isIdle()) {
					await new Promise<void>((resolve) => {
						const fallback = setTimeout(resolve, IDLE_WAIT_MS);
						fallback.unref?.();
						onSettled = () => {
							clearTimeout(fallback);
							resolve();
						};
					});
				}
				if (!current() || !turnCtx.isIdle()) return;
				const text = turnCtx.ui.getEditorText().trim();
				if (!text) return;
				turnCtx.ui.setEditorText("");
				pi.sendUserMessage(text);
			} finally {
				sending = false;
			}
		};

		// The widget factory hands over the TUI, whose input path replays a held key.
		let tui: { handleTerminalInput?(data: string): void } | undefined;
		let replaying = false;
		const replay = (held: string) => {
			if (typeof tui?.handleTerminalInput !== "function") return;
			replaying = true;
			try {
				tui.handleTerminalInput(held);
			} finally {
				replaying = false;
			}
		};
		const chord = new SendNowChord();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stopUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (replaying) return undefined;
			clearTimeout(timer);
			const action = chord.feed(data, active());
			switch (action.kind) {
				case "hold":
					timer = setTimeout(() => {
						const held = chord.expire();
						if (held !== undefined && current()) replay(held);
					}, CHORD_TIMEOUT_MS);
					timer.unref?.();
					return { consume: true };
				case "send":
					void sendNow(ctx);
					return { consume: true };
				case "replay":
					replay(action.held);
					return undefined;
				default:
					return undefined;
			}
		});
		unsubscribe = () => {
			clearTimeout(timer);
			stopUnsubscribe();
		};

		ctx.ui.setWidget("send-now", (widgetTui, theme) => {
			tui = widgetTui as typeof tui;
			const paint = safeThemePaint(theme);
			let cache: { key: string; lines: string[] } | undefined;
			return {
				render: (width: number) => {
					const shown = queued();
					const key = `${width}:${shown}`;
					if (cache?.key === key) return cache.lines;
					const lines = shown ? [truncateLine(paint("dim", ` ↳ ${SEND_NOW_HINT}`), width)] : [];
					cache = { key, lines };
					return lines;
				},
				invalidate: () => {
					cache = undefined;
				},
			};
		});
	});
}
