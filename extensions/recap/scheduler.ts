/**
 * Pure idle-timer state machine for the recap (no pi imports, so it is
 * unit-tested directly; index.ts is thin wiring).
 *
 * The recap fires after a lull with no interaction following a turn — the
 * closest faithful substitute for Claude Code's 5-minute terminal-blur trigger,
 * which pi exposes no event for. The rules:
 *   - armed when a turn ends, re-armed on any keystroke, cleared while a turn runs;
 *   - at most one recap per user turn (CC's hasSummarySinceLastUserTurn guard);
 *   - `reset()` drops a pending fire and all turn state, so a timer armed by a
 *     previous session can never fire against a new one (after /clear).
 *
 * The clock is injected (`TimerOps`) so tests drive it deterministically; the
 * async model call it triggers stays in the extension.
 */

export interface TimerOps {
	/** Schedule `cb` after `ms`; return a handle for `clear`. */
	set(cb: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export class RecapScheduler {
	private turnRunning = false;
	private firedSinceTurn = false;
	private handle: unknown;

	constructor(
		private readonly timer: TimerOps,
		/** The idle delay in ms, read at arm time. */
		private readonly idleMs: () => number,
		/** Whether the recap is enabled (e.g. CC_RECAP !== "0"). */
		private readonly enabled: () => boolean,
		/** Called when the idle timer elapses. */
		private readonly onFire: () => void,
	) {}

	private clear(): void {
		if (this.handle !== undefined) {
			this.timer.clear(this.handle);
			this.handle = undefined;
		}
	}

	private arm(): void {
		this.clear();
		if (this.turnRunning || this.firedSinceTurn || !this.enabled()) return;
		this.handle = this.timer.set(() => {
			this.handle = undefined;
			this.onFire();
		}, this.idleMs());
	}

	/** A turn began: cancel any pending recap and allow a fresh one after it. */
	turnStarted(): void {
		this.turnRunning = true;
		this.firedSinceTurn = false;
		this.clear();
	}

	/** A turn ended: start the idle countdown. */
	turnEnded(): void {
		this.turnRunning = false;
		this.arm();
	}

	/** Any interaction between turns resets the idle clock. */
	interacted(): void {
		if (!this.turnRunning) this.arm();
	}

	/** New session or shutdown: drop the pending fire and all turn state. */
	reset(): void {
		this.turnRunning = false;
		this.firedSinceTurn = false;
		this.clear();
	}

	/** A recap was emitted; suppress another until the next turn. */
	markFired(): void {
		this.firedSinceTurn = true;
	}

	get hasFiredSinceTurn(): boolean {
		return this.firedSinceTurn;
	}
}
