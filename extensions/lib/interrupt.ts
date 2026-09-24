/**
 * Read how an agent run ended off its last assistant message.
 *
 * pi marks the assistant message it was streaming with `stopReason: "aborted"`
 * when the user hits Esc (or otherwise calls `ctx.abort()`), and with
 * `stopReason: "error"` when the provider call failed; a run that completed
 * carries "stop"/"toolUse"/etc. instead. Claude Code keys its InterruptedByUser
 * line off the same abort signal (ERROR_MESSAGE_USER_ABORT on the last
 * assistant message). Duck-typed so the extensions that need it can share it
 * without pulling in pi's message types.
 *
 * **One abort is mislabelled.** An abort that lands between a stored tool
 * result and the next stream start (the tool saw the signal and returned
 * "Command aborted"; the loop still has a queued steer to deliver, so it calls
 * the provider with the signal already aborted) comes back as an assistant
 * message with EMPTY content, `stopReason: "error"` and `errorMessage: "This
 * operation was aborted"` — the fetch layer's AbortError, not pi's "aborted"
 * label (measured over RPC on pi 0.85.0, STEERING-REVIEW-2026-09-05 L1;
 * upstream ask working-docs/upstream_prs.md #18). The run's abort signal is still the
 * ground truth, and `ctx.signal` at `agent_end` is that signal (pi's
 * `activeRun` outlives the event), so callers pass `ctx.signal?.aborted` and
 * an `error` stop on an aborted run reads as "aborted": the user stopped the
 * turn, and everything downstream (the Interrupted line, the notifier's
 * post-abort hold, the Stop-hook skip) treats it as it treats Esc. Matching
 * the error text was rejected: three libraries' wordings, any of which can
 * change under us.
 *
 * **One turn is not one run.** `agent_end` fires per low-level run, and pi
 * continues on its own afterwards in three cases: an auto-retry of a transient
 * provider error, an auto-compaction followed by a retry, and a queued
 * follow-up message. `agent_settled` is the one event meaning pi will not
 * continue by itself, and it carries no messages — so anything that reports a
 * turn as finished listens on `agent_settled` and keeps a `RunOutcomeLatch` to
 * carry the outcome over from the runs' `agent_end`. Findings §3.
 */

/** How the last assistant message of a run ended. */
export type RunOutcome = "ok" | "aborted" | "error";

/** The only fields of a run's messages any of this reads. */
export interface RunMessage {
	role: string;
	stopReason?: string;
}

/**
 * Classify a run from its messages; a run with no assistant message counts as
 * "ok". `signalAborted` is the run's abort signal at `agent_end`
 * (`ctx.signal?.aborted`): it turns an `error` stop into "aborted" (see the
 * header) and leaves a completed stop alone — a signal aborted after the final
 * message landed did not interrupt anything.
 */
export function runOutcome(messages: ReadonlyArray<RunMessage> | undefined, signalAborted = false): RunOutcome {
	if (!messages) return "ok";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return signalAborted ? "aborted" : "error";
		return "ok";
	}
	return "ok";
}

/** The last assistant message in a turn was aborted by the user. */
export function wasInterrupted(messages: ReadonlyArray<RunMessage> | undefined, signalAborted = false): boolean {
	return runOutcome(messages, signalAborted) === "aborted";
}

/**
 * Carries the last run's outcome from `agent_end` to `agent_settled`.
 *
 * Empty reads as `undefined` rather than "ok", so "no run ended in this turn"
 * stays distinguishable from "a run finished cleanly". A settle with nothing
 * recorded means the turn produced no response at all, and a caller gating on
 * `=== "ok"` then holds off by construction instead of treating the stale
 * default as success. `take()` empties the latch, so the next turn starts clean
 * whether or not this turn's outcome was read.
 */
export class RunOutcomeLatch {
	private outcome: RunOutcome | undefined;

	/** `agent_end`: record how that run ended (pass `ctx.signal?.aborted`), replacing any earlier run's. */
	record(messages: ReadonlyArray<RunMessage> | undefined, signalAborted = false): void {
		this.outcome = runOutcome(messages, signalAborted);
	}

	/** `agent_settled`: the settled turn's outcome, or undefined if no run ended. */
	take(): RunOutcome | undefined {
		const outcome = this.outcome;
		this.outcome = undefined;
		return outcome;
	}
}
