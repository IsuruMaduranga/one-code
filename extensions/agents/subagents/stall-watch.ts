/**
 * A subagent turn that makes no progress for ten minutes fails, as Claude
 * Code's async-agent stall watchdog does (findings §94: stream idle plus
 * 300 s, every streamed chunk counts as progress, deferred while a tool runs,
 * "Agent stalled: no progress for Ns (stream watchdog did not recover)").
 *
 * It is the backstop behind pi's own stream watchdog: pi sets a 300 s idle
 * timeout on every HTTP stream (undici `bodyTimeout`) and on Codex's
 * WebSocket, and its auto-retry re-sends a request that timed out, up to
 * three times (findings §91). A stream that never recovers would otherwise
 * hold the turn through every retry until the runner's 30-minute wall-clock
 * cap.
 *
 * Like Claude Code's, it watches background agents only (residents); a
 * blocking run keeps the caller's turn and the user's Esc.
 *
 * `StallWatch` is the clock, pure. runner.ts `stallWatchExtension` feeds it
 * the child's events and, on a stall, stops the turn the way the tool-call
 * guard does: `TURN_FAILED_CHANNEL` with the reason, then an abort.
 */

/** Claude Code's default: the 300 s stream idle timeout plus 300 s. */
export const AGENT_STALL_MS = 600_000;

/** What the watch adds to the stream idle timeout, as Claude Code does. */
const STALL_MARGIN_MS = 300_000;

/**
 * The stall timeout for a subagent turn, undefined for none: the knob
 * (`<prefix>_ASYNC_AGENT_STALL_TIMEOUT_MS`, Claude Code's
 * CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS; 0 turns the watch off) when it is a
 * number, else pi's HTTP idle timeout plus 300 s, and none when that timeout
 * is disabled (0), since a user who lets a stream sit silent lets a turn too.
 */
export function agentStallMs(knob: string | undefined, httpIdleMs: number): number | undefined {
	const set = knob === undefined || knob.trim() === "" ? Number.NaN : Number(knob);
	if (Number.isFinite(set) && set >= 0) return set === 0 ? undefined : Math.floor(set);
	return httpIdleMs > 0 ? httpIdleMs + STALL_MARGIN_MS : undefined;
}

/**
 * One session's turns. A turn starts the clock, every streamed chunk and every
 * finished tool restarts it, a running tool or a compaction pauses it, and the
 * turn settling stops it. `onStall` runs at most once per turn.
 */
export class StallWatch {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private turn = false;
	private tools = 0;
	private compacting = false;
	private fired = false;

	constructor(
		private readonly onStall: (seconds: number) => void,
		private readonly ms: number = AGENT_STALL_MS,
	) {}

	/**
	 * A turn started, or pi started it again (a retry): the clock runs from the
	 * turn's start and is not restarted, so silent retries add up.
	 */
	turnStarted(): void {
		if (!this.turn) {
			this.turn = true;
			this.tools = 0;
			this.compacting = false;
			this.fired = false;
		}
		this.run(false);
	}

	/** A streamed chunk: the clock restarts. An error reply is not one, so a failed retry does not reset it. */
	progress(): void {
		this.run(true);
	}

	/** A reply started: the clock runs again after a compaction pause, whatever became of the compaction, without restarting. */
	replyStarted(): void {
		this.compacting = false;
		this.run(false);
	}

	toolStarted(): void {
		this.tools++;
		this.clear();
	}

	/** A tool ended: the clock starts afresh, as it does after any step that made progress. */
	toolEnded(): void {
		this.tools = Math.max(0, this.tools - 1);
		this.run(true);
	}

	compactionStarted(): void {
		this.compacting = true;
		this.clear();
	}

	compactionEnded(): void {
		this.compacting = false;
		this.run(true);
	}

	/** The turn settled, or the session is going away. */
	stop(): void {
		this.turn = false;
		this.clear();
	}

	/** Start the clock if it is stopped; with `restart`, also restart a running one. */
	private run(restart: boolean): void {
		if (!this.turn || this.fired || this.tools > 0 || this.compacting) return;
		if (this.timer) {
			if (restart) this.timer.refresh();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.fired = true;
			this.onStall(Math.round(this.ms / 1000));
		}, this.ms);
		this.timer.unref?.();
	}

	private clear(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
