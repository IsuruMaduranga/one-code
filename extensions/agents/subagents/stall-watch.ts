/**
 * A subagent turn that makes no progress for ten minutes fails, as Claude
 * Code's async-agent stall watchdog does (findings §94: stream idle plus
 * 300 s, every streamed chunk counts as progress, deferred while a tool runs,
 * "Agent stalled: no progress for Ns (stream watchdog did not recover)").
 *
 * It is the backstop behind pi's own stream watchdog: pi installs a 300 s
 * idle timeout on every HTTP stream (undici `bodyTimeout`) and on Codex's
 * WebSocket, and its auto-retry re-sends a request that timed out ("timeout"
 * and "terminated" are retryable), up to three times. A stream that never
 * recovers would otherwise hold the turn through every retry until the
 * runner's 30-minute wall-clock cap.
 *
 * Pure: fed the session's events by the runner (runner.ts wireTracker), and
 * every raw provider event through `progress()` (a provider can stream events
 * that make no message update), it
 * calls `onStall` once per turn and never touches the session itself.
 */

/** Claude Code's default: the 300 s stream idle timeout plus 300 s. */
export const AGENT_STALL_MS = 600_000;

/** The session events the watch reads. */
interface WatchedEvent {
	type?: string;
}

/** What counts as progress: the turn starting, and every message event (each streamed chunk is a `message_update`). */
const PROGRESS: ReadonlySet<string> = new Set(["agent_start", "message_start", "message_update", "message_end"]);

/**
 * Watches one session's turns. A turn starts the clock (`agent_start`), every
 * message event restarts it, a running tool or a compaction pauses it, and the
 * turn settling (`agent_settled`) stops it.
 */
export class StallWatch {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private turn = false;
	private paused = 0;
	private fired = false;

	constructor(
		private readonly onStall: (seconds: number) => void,
		private readonly ms: number = AGENT_STALL_MS,
	) {}

	/** Feed one session event. */
	observe(event: WatchedEvent): void {
		switch (event.type) {
			case "agent_start":
				if (!this.turn) {
					this.turn = true;
					this.paused = 0;
					this.fired = false;
				}
				this.arm();
				return;
			case "tool_execution_start":
			case "compaction_start":
				this.paused++;
				this.clear();
				return;
			case "tool_execution_end":
			case "compaction_end":
				this.paused = Math.max(0, this.paused - 1);
				this.arm();
				return;
			case "agent_settled":
				this.stop();
				return;
			default:
				if (event.type && PROGRESS.has(event.type)) this.arm();
		}
	}

	/** A raw provider event arrived: progress, as every streamed chunk is. */
	progress(): void {
		this.arm();
	}

	/** Stop watching (the turn settled or the session is going away). */
	stop(): void {
		this.turn = false;
		this.paused = 0;
		this.clear();
	}

	private arm(): void {
		if (!this.turn || this.paused > 0 || this.fired) return;
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

	private clear(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
