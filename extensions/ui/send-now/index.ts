/**
 * send-now extension — Claude Code's "send now" for messages queued mid-turn.
 *
 * A message typed while a turn runs waits in pi's queue until the current
 * response and its tool calls finish. `ctrl+x ctrl+s` (chord.ts) delivers it
 * at once: the running turn is aborted, which makes pi move every queued
 * message and the draft back into the editor (its abort handler), and once the
 * session is idle that text is sent as the next prompt (a pasted image is its
 * file path in the text, so nothing is lost). Running tools are cancelled, as in Claude Code before 2.1.283, which moves
 * them to the background instead. A dim `ctrl+x ctrl+s to send now` line sits
 * above the editor while anything is queued.
 *
 * pi binds `ctrl+x` alone to copy; while send now applies, `ctrl+x` is only the
 * prefix of the chord (lib/ui/ctrl-x-chord.ts, shared with the stop-agents
 * chord), and one no chord completes (another key, or the timeout) is dropped.
 * Only public extension API.
 *
 * pi exposes no read of its queue to extensions, only `hasPendingMessages()`,
 * so the hint asks on every render rather than tracking queue events (a
 * dequeue with alt+up fires none). TUI only.
 */

import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SEND_NOW_CHANNEL } from "../../lib/notify/send-now-channel.ts";
import { claimChordKey, CtrlXPrefix } from "../../lib/ui/ctrl-x-chord.ts";
import { safeThemePaint, truncateLine } from "../../lib/ui/tui-render.ts";

/** The hint under the queued messages, Claude Code's wording (its `chat:sendNow`). */
export const SEND_NOW_HINT = "ctrl+x ctrl+s to send now";

/** How long send now waits for the aborted turn to settle before giving up. */
const IDLE_WAIT_MS = 10_000;

function sendNowExtension(pi: ExtensionAPI) {
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
				// followUp: an async UserPromptSubmit hook runs before pi's busy
				// check, and on pi 1.2.0 a run starting meanwhile would reject a
				// bare send after the editor was cleared.
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			} finally {
				sending = false;
			}
		};

		const prefix = new CtrlXPrefix(pi.events);
		const stopListening = ctx.ui.onTerminalInput((data) => prefix.feed(data));
		const stopClaiming = claimChordKey(pi.events, "ctrl+s", { applies: active, act: () => void sendNow(ctx) });
		unsubscribe = () => {
			prefix.disarm();
			stopListening();
			stopClaiming();
		};

		ctx.ui.setWidget("send-now", (_tui, theme) => {
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

export default feature("send-now", sendNowExtension);
