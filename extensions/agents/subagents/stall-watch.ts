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
 * `StallWatch` is the clock, pure. runner.ts `stallWatchExtension` feeds it
 * the child's events and, on a stall, stops the turn the way the tool-call
 * guard does: `TURN_FAILED_CHANNEL` with the reason, then an abort.
 */

/** Claude Code's default: the 300 s stream idle timeout plus 300 s. */
export const AGENT_STALL_MS = 600_000;

/**
 * One session's turns. A turn starts the clock, every streamed chunk restarts
 * it, a running tool or a compaction pauses it, and the turn settling stops
 * it. `onStall` runs at most once per turn.
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

	turnStarted(): void {
		if (!this.turn) {
			this.turn = true;
			this.tools = 0;
			this.compacting = false;
			this.fired = false;
		}
		this.progress();
	}

	/** A streamed chunk or message event: the clock restarts. */
	progress(): void {
		if (!this.turn || this.fired || this.tools > 0 || this.compacting) return;
		if (this.timer) {
			this.timer.refresh();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.fired = true;
			this.onStall(Math.round(this.ms / 1000));
		}, this.ms);
		this.timer.unref?.();
	}

	/** A new reply: progress, and the end of a compaction pause whatever became of the compaction. */
	replyStarted(): void {
		this.compacting = false;
		this.progress();
	}

	toolStarted(): void {
		this.tools++;
		this.clear();
	}

	toolEnded(): void {
		this.tools = Math.max(0, this.tools - 1);
		this.progress();
	}

	compactionStarted(): void {
		this.compacting = true;
		this.clear();
	}

	compactionEnded(): void {
		this.compacting = false;
		this.progress();
	}

	/** The turn settled, or the session is going away. */
	stop(): void {
		this.turn = false;
		this.clear();
	}

	private clear(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
