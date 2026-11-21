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
 * `ctrl+x ctrl+s`: the chord is registered on the shared prefix
 * (lib/ui/ctrl-x-chord.ts), which holds `ctrl+x` only while some chord
 * applies, this one while an agent runs. index.ts wires the keys, the strip
 * and the stop.
 */

/** Claude Code's window for the second press. */
export const STOP_ALL_CONFIRM_MS = 3000;
/** The strip's hint while agents run, Claude Code's footer wording. */
export const STOP_ALL_HINT = "ctrl+x ctrl+k to stop agents";
/** The first press's prompt, Claude Code's wording. */
export const STOP_ALL_CONFIRM = "Press ctrl+x ctrl+k again to stop background agents";

/**
 * The two presses: the first asks, a second inside the window stops. The
 * question is about the agents running when it was asked, so it holds only
 * while every agent running now was among them: an agent that started since
 * (one finished and another began inside the three seconds) makes the next
 * press ask again instead of stopping an agent the user was never asked
 * about, and with none running nothing is being asked.
 */
export class StopAllPresses {
	private asked: { at: number; agents: ReadonlySet<string> } | undefined;

	/** One press, given the task ids of the agents the stop would stop now. */
	press(now: number, running: readonly string[]): "confirm" | "stop" {
		if (this.asking(now, running)) {
			this.asked = undefined;
			return "stop";
		}
		this.asked = { at: now, agents: new Set(running) };
		return "confirm";
	}

	/** Whether the first press's question still stands for the agents running now. */
	asking(now: number, running: readonly string[]): boolean {
		const asked = this.asked;
		if (asked === undefined || now - asked.at > STOP_ALL_CONFIRM_MS) return false;
		return running.length > 0 && running.every((taskId) => asked.agents.has(taskId));
	}
}

/** What the strip reads about the chord at each render (index.ts owns the predicate). */
export interface StopAllState {
	/** The chord would act now: an agent it stops is running (the same predicate the key's `applies` uses). */
	applies: boolean;
	/** The first press's question still stands. */
	asking: boolean;
}

/**
 * The strip's `main` row note while an agent runs: the prompt after a first
 * press, else the hint. A focused strip's hint line already names the key, so
 * there the row shows only the prompt.
 */
export function stopAllNote(asking: boolean, agentsRunning: boolean, focused: boolean): string | undefined {
	if (!agentsRunning) return undefined;
	if (asking) return STOP_ALL_CONFIRM;
	return focused ? undefined : STOP_ALL_HINT;
}
