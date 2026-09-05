/**
 * The wall-clock span of one user-visible turn.
 *
 * A turn can hold several agent runs (see `lib/interrupt.ts` for why), so the
 * span opens on the FIRST run and closes at settle: a retried run keeps the
 * original start, which is what makes the rendered duration the time the user
 * actually waited rather than the time the last attempt took.
 *
 * A turn that ends aborted or errored renders nothing: the interrupted
 * extension prints its own note for an abort, and pi prints its own retry
 * failure for an error. Claude Code gates its turn line the same way.
 */

import { type RunMessage, RunOutcomeLatch } from "../lib/interrupt.ts";

export class TurnSpan {
	/** Undefined rather than 0 for "no span open", so a start of 0 is still a start. */
	private startedAt: number | undefined;
	private readonly outcome = new RunOutcomeLatch();

	/** `agent_start`: opens the span; a retry/continuation is a no-op, keeping the first start. */
	runStarted(now: number): void {
		this.startedAt ??= now;
	}

	/** `agent_end`: remembers how that run ended (with the run's `signal.aborted`), for settle to read. */
	runEnded(messages: ReadonlyArray<RunMessage> | undefined, signalAborted = false): void {
		this.outcome.record(messages, signalAborted);
	}

	/**
	 * `agent_settled`: closes the span and returns the duration to render, or
	 * undefined when this turn should show no line at all.
	 */
	settle(now: number): number | undefined {
		const startedAt = this.startedAt;
		this.startedAt = undefined;
		if (this.outcome.take() !== "ok" || startedAt === undefined) return undefined;
		return Math.max(0, now - startedAt);
	}
}
