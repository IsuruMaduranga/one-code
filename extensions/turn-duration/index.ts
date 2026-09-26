/**
 * turn-duration extension — Claude Code's "✻ Cooked for 5m 12s" line shown in
 * the transcript after each response.
 *
 * The turn's wall-clock is measured across agent_start→agent_settled by span.ts
 * (one turn can hold several runs — `lib/interrupt.ts`) and emitted as a
 * display-only session entry (`appendEntry` — not part of the LLM context, so
 * the model never sees its own timing line), rendered dim and led by the ✻ mark
 * to match CC's TurnDurationMessage. CC shows it after every response with no
 * threshold and defaults it on; CC_TURN_DURATION=0 opts out. The completion verb
 * is sampled once per turn from CC's 8-verb list. The line ends with CC's
 * `· done <time>` (the entry's timestamp, line.ts formatDoneAt) and, when
 * background shells outlive the turn, `· N shells still running`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trackShellTasks } from "../lib/shell-tasks.ts";
import { dimMarkedLine } from "../lib/tui-render.ts";
import { formatDoneAt, TURN_MARK, turnDurationText } from "./line.ts";
import { TurnSpan } from "./span.ts";
import { pickCompletionVerb } from "./verbs.ts";

const ENTRY_TYPE = "one-code:turn-duration";

interface TurnDurationData {
	verb: string;
	durationMs: number;
	/** Background shells still running when the turn ended (CC's `· 2 shells still running`). */
	runningShells?: number;
}

export default function turnDurationExtension(pi: ExtensionAPI) {
	const shellTasks = trackShellTasks(pi);

	pi.registerEntryRenderer<TurnDurationData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		// The entry's own timestamp is when the turn settled: Claude Code's `· done 2:33 PM`.
		const doneAt = formatDoneAt(new Date(entry.timestamp));
		return dimMarkedLine(theme, TURN_MARK, turnDurationText(data.verb, data.durationMs, data.runningShells ?? 0, doneAt));
	});

	const span = new TurnSpan();

	pi.on("agent_start", () => {
		span.runStarted(Date.now());
	});

	pi.on("agent_end", (event, ctx) => {
		span.runEnded(event.messages, ctx.signal?.aborted);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const durationMs = span.settle(Date.now());
		if (durationMs === undefined) return;
		if (process.env.CC_TURN_DURATION === "0") return;
		if (!ctx.hasUI) return;
		pi.appendEntry<TurnDurationData>(ENTRY_TYPE, {
			verb: pickCompletionVerb(),
			durationMs,
			runningShells: shellTasks.running().length,
		});
	});
}
