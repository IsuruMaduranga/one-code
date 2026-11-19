/**
 * Claude Code's "stop all background agents" key (`chat:killAgents`,
 * `ctrl+x ctrl+k`), pure. It works from the prompt, not only from the focused
 * agent strip, and takes two presses: the first shows "Press ctrl+x ctrl+k
 * again to stop background agents", and a second within three seconds stops
 * every running agent. Its own per-agent notifications are dropped and the
 * model hears one line instead: `Background agent "X" was stopped by the
 * user.` (subagent-text.ts `stoppedByUser`).
 *
 * `ctrl+x` is also pi's copy key and the prefix of send now's
 * `ctrl+x ctrl+s`, so the prompt chord holds it only while an agent runs, and
 * a held `ctrl+x` followed by another key offers that key to the other chord
 * (lib/ui/ctrl-x-chord.ts). index.ts wires the keys, the strip and the stop.
 */

import { isKeyRelease, keyId } from "../../lib/ui/key-input.ts";

/** Claude Code's window for the second press. */
export const STOP_ALL_CONFIRM_MS = 3000;
/** How long a held `ctrl+x` waits for the next key, as send now's does. */
export const PROMPT_CHORD_TIMEOUT_MS = 1000;
/** The strip's hint while agents run, Claude Code's footer wording. */
export const STOP_ALL_HINT = "ctrl+x ctrl+k to stop agents";
/** The first press's prompt, Claude Code's wording. */
export const STOP_ALL_CONFIRM = "Press ctrl+x ctrl+k again to stop background agents";

/** What the prompt chord does with a key: let it through, hold it, offer it to another chord, or count a stop-all press. */
export type PromptChordAction = "pass" | "hold" | "offer" | "stopAll";

/** The `ctrl+x ctrl+k` chord typed at the prompt. */
export class PromptChord {
	private armed = false;

	/** Feed one key; `active` is whether an agent runs (only then is `ctrl+x` held). */
	feed(data: string, active: boolean): PromptChordAction {
		if (isKeyRelease(data)) return "pass";
		const id = keyId(data);
		const armed = this.armed;
		this.armed = false;
		if (id === "ctrl+x" && active) {
			this.armed = true;
			return "hold";
		}
		if (!armed) return "pass";
		return id === "ctrl+k" ? "stopAll" : "offer";
	}

	/** The held `ctrl+x` timed out. */
	expire(): void {
		this.armed = false;
	}
}

/** The two presses: the first asks, a second inside the window stops. */
export class StopAllPresses {
	private askedAt: number | undefined;

	press(now: number): "confirm" | "stop" {
		if (this.askedAt !== undefined && now - this.askedAt <= STOP_ALL_CONFIRM_MS) {
			this.askedAt = undefined;
			return "stop";
		}
		this.askedAt = now;
		return "confirm";
	}

	/** Whether the first press's prompt still shows. */
	asking(now: number): boolean {
		return this.askedAt !== undefined && now - this.askedAt <= STOP_ALL_CONFIRM_MS;
	}
}

/**
 * The strip's `main` row note while an agent runs: the prompt after a first
 * press, else the hint. A focused strip's hint line already names the key, so
 * there the row shows only the prompt.
 */
export function stopAllNote(asking: boolean, agentsRunning: boolean, focused = false): string | undefined {
	if (!agentsRunning) return undefined;
	if (asking) return STOP_ALL_CONFIRM;
	return focused ? undefined : STOP_ALL_HINT;
}
