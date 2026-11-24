/**
 * Pure idle-timer state machine for the recap (no pi imports, so it is
 * unit-tested directly; index.ts is thin wiring).
 *
 * The recap fires after a lull with no interaction following a turn, the
 * closest substitute for Claude Code's terminal-blur trigger, which pi exposes
 * no event for. The rules:
 *   - armed when a turn ends, cleared while a turn runs;
 *   - the delay counts from the turn end, as Claude Code's does: a keystroke
 *     only holds the fire back until QUIET_MS after it (Claude Code fires 2 s
 *     after a later blur; a keystroke is not a blur, so the gap is longer).
 *     Restarting the full delay from a keystroke would push the fire past the
 *     cache-stale point and lose the recap;
 *   - whether a fire may run a recap is policy.ts's call, read from the branch,
 *     so a recap already shown holds the next one off across a resume too;
 *   - failed recaps are counted per turn (Claude Code stops at three);
 *   - `reset()` drops a pending fire and all turn state, so a timer armed by a
 *     previous session can never fire against a new one (after /clear).
 *
 * The clock is injected (`TimerOps`) so tests drive it deterministically; the
 * async model call it triggers stays in the extension.
 */

import type { TimerOps } from "../../lib/core/timer-ops.ts";

export type { TimerOps };

/** How long after a keystroke the recap waits at least: Claude Code's minimum recap delay. */
export const QUIET_MS = 30_000;

export class RecapScheduler {
	private turnRunning = false;
	private failures = 0;
	private handle: unknown;
	private turnEndedAt: number | undefined;
	private lastInputAt: number | undefined;

	constructor(
		private readonly timer: TimerOps,
		private readonly now: () => number,
		/** The delay after a turn end in ms, read at arm time. */
		private readonly idleMs: () => number,
		/** Whether the recap is enabled (the `recap` feature decides; the scheduler keeps the hook for tests). */
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
		if (this.turnRunning || this.turnEndedAt === undefined || !this.enabled()) return;
		const due = Math.max(this.turnEndedAt + this.idleMs(), this.lastInputAt === undefined ? 0 : this.lastInputAt + QUIET_MS);
		this.handle = this.timer.set(() => {
			this.handle = undefined;
			this.onFire();
		}, Math.max(0, due - this.now()));
	}

	/** A turn began: cancel any pending recap. */
	turnStarted(): void {
		this.turnRunning = true;
		this.clear();
	}

	/** A turn ended: a fresh failure budget, and the idle countdown starts. */
	turnEnded(): void {
		this.turnRunning = false;
		this.failures = 0;
		this.turnEndedAt = this.now();
		this.lastInputAt = undefined;
		this.arm();
	}

	/** Any interaction between turns holds the fire back until QUIET_MS after it. */
	interacted(): void {
		if (this.turnRunning) return;
		this.lastInputAt = this.now();
		this.arm();
	}

	/** New session or shutdown: drop the pending fire and all turn state. */
	reset(): void {
		this.turnRunning = false;
		this.failures = 0;
		this.turnEndedAt = undefined;
		this.lastInputAt = undefined;
		this.clear();
	}

	/** A recap call failed. */
	markFailed(): void {
		this.failures++;
	}

	get failuresThisTurn(): number {
		return this.failures;
	}
}
