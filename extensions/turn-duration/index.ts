/**
 * turn-duration extension — Claude Code's "✻ Cooked for 5m 12s" line shown in
 * the transcript after each response.
 *
 * The turn's wall-clock is measured across agent_start→agent_end and emitted as
 * a display-only session entry (`appendEntry` — not part of the LLM context, so
 * the model never sees its own timing line), rendered dim and led by the ✻ mark
 * to match CC's TurnDurationMessage. CC shows it after every response with no
 * threshold and defaults it on; CC_TURN_DURATION=0 opts out. The completion verb
 * is sampled once per turn from CC's 8-verb list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dimMarkedLine } from "../lib/tui-render.ts";
import { TURN_MARK, turnDurationText } from "./line.ts";
import { pickCompletionVerb } from "./verbs.ts";

const ENTRY_TYPE = "one-code:turn-duration";

interface TurnDurationData {
	verb: string;
	durationMs: number;
}

export default function turnDurationExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<TurnDurationData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		return dimMarkedLine(theme, TURN_MARK, turnDurationText(data.verb, data.durationMs));
	});

	let turnStartedAt = 0;

	pi.on("agent_start", () => {
		turnStartedAt = Date.now();
	});

	pi.on("agent_end", (_event, ctx) => {
		const startedAt = turnStartedAt;
		turnStartedAt = 0;
		if (process.env.CC_TURN_DURATION === "0") return;
		if (!startedAt || !ctx.hasUI) return;
		pi.appendEntry<TurnDurationData>(ENTRY_TYPE, {
			verb: pickCompletionVerb(),
			durationMs: Date.now() - startedAt,
		});
	});
}
