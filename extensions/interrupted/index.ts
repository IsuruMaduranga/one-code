/**
 * interrupted extension — Claude Code's "Interrupted · What should One Code do
 * instead?" line, shown when the user aborts a turn (Esc).
 *
 * On agent_end, if the turn's last assistant message was aborted by the user
 * (findings: pi marks it `stopReason: "aborted"`, or `"error"` on a run whose
 * signal is aborted when the abort reached the provider call —
 * `lib/interrupt.ts`), a display-only session entry
 * is appended (`appendEntry` — not part of the LLM context, so the model never
 * sees the note about its own interruption), rendered dim to match CC's
 * InterruptedByUser component. The paired turn-duration line suppresses itself
 * on the same signal, so an interrupted turn shows this note in place of the
 * "Cooked for …" line — CC's behaviour (its turn-duration render is gated on
 * `!aborted`). A send now (ctrl+x ctrl+s, the send-now extension) aborts the
 * turn too, but gets no note: the user has already said what to do instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wasInterrupted } from "../lib/interrupt.ts";
import { SEND_NOW_CHANNEL } from "../lib/send-now-channel.ts";
import { linesComponent, safeThemePaint } from "../lib/tui-render.ts";
import { INTERRUPTED_TEXT } from "./line.ts";

const ENTRY_TYPE = "one-code:interrupted";

export default function interruptedExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer(ENTRY_TYPE, (_entry, _options, theme) => {
		const paint = safeThemePaint(theme);
		return linesComponent(() => [paint("dim", INTERRUPTED_TEXT)]);
	});

	// Send now aborts the turn to deliver the queued messages: the user has
	// already said what to do instead, so that abort gets no note.
	let sendingNow = false;
	pi.events.on(SEND_NOW_CHANNEL, () => {
		sendingNow = true;
	});

	pi.on("agent_end", (event, ctx) => {
		const skip = sendingNow;
		sendingNow = false;
		if (skip) return;
		if (!ctx.hasUI) return;
		if (!wasInterrupted(event.messages, ctx.signal?.aborted)) return;
		pi.appendEntry(ENTRY_TYPE);
	});
}
