/**
 * interrupted extension — Claude Code's "Interrupted · What should One Code do
 * instead?" line, shown when the user aborts a turn (Esc).
 *
 * On agent_end, if the turn's last assistant message was aborted by the user
 * (findings: pi marks it `stopReason: "aborted"`), a display-only session entry
 * is appended (`appendEntry` — not part of the LLM context, so the model never
 * sees the note about its own interruption), rendered dim to match CC's
 * InterruptedByUser component. The paired turn-duration line suppresses itself
 * on the same signal, so an interrupted turn shows this note in place of the
 * "Cooked for …" line — CC's behaviour (its turn-duration render is gated on
 * `!aborted`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wasInterrupted } from "../lib/interrupt.ts";
import { linesComponent, safeThemePaint } from "../lib/tui-render.ts";
import { INTERRUPTED_TEXT } from "./line.ts";

const ENTRY_TYPE = "one-code:interrupted";

export default function interruptedExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer(ENTRY_TYPE, (_entry, _options, theme) => {
		const paint = safeThemePaint(theme);
		return linesComponent(() => [paint("dim", INTERRUPTED_TEXT)]);
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!wasInterrupted(event.messages)) return;
		pi.appendEntry(ENTRY_TYPE);
	});
}
