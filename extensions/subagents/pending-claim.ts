/**
 * The backstop for a fabricated agent result (pure).
 *
 * Putting Claude Code's prohibition in the Agent tool's RESULT rather than only
 * in its description was the first fix for WEAK-MODEL-REVIEW-2026-09-06 H1, and
 * measured live it was not enough: `openai-codex/gpt-5.6-luna` still ended a
 * turn with the pending agent's answer in 3 of 6 `pending` runs, with the
 * prohibition verifiably on the wire. The failure has a signature — the model
 * writes "I'm waiting for the agent's result" and then states the result in the
 * same message — and a shape the harness can see without reading the text at
 * all: the agent loop ended while a run started inside it was still live.
 *
 * So the harness says so on the next request. This cannot un-print the sentence
 * the user already saw; what it does is stop the model treating the real
 * notification as confirmation of something it invented, which is how the
 * fabrication survived into the final answer ("The agent confirmed the same
 * result").
 *
 * Wording is deliberately CONDITIONAL. The trigger fires on correct behaviour
 * too — a model that said only "I'm waiting for the agent" ends its turn the
 * same way — so the text must not accuse. Measured precision on the six-run
 * battery: 4 fires, 3 of them real fabrications.
 */

/** A live run the model started during the agent loop that just ended. */
export interface PendingRun {
	name: string;
	taskId: string;
}

/**
 * The one-shot for a turn that ended with runs still pending, or undefined when
 * there is nothing to say. Named runs, so a model with several in flight knows
 * which ones it cannot have heard from.
 */
export function pendingClaimReminder(runs: readonly PendingRun[]): string | undefined {
	if (runs.length === 0) return undefined;
	const named = runs.map((run) => `${run.name} (task ${run.taskId})`).join(", ");
	const subject = runs.length === 1 ? "It has" : "They have";
	return (
		`You ended that turn while ${named} ${runs.length === 1 ? "was" : "were"} still running. ${subject} not reported yet, ` +
		"so anything you stated about the result did not come from the agent — if you gave the user a result, say plainly in your next message that it was not the agent's and correct it. " +
		"Wait for the notification, or call task_output with block=true."
	);
}
