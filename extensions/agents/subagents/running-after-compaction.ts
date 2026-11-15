import { type PendingRun, subagentResultText } from "../../lib/agents/subagent-text.ts";

/**
 * The background agents still working when a compaction summarized the calls
 * that started them: the new epoch's history no longer shows them, so a model
 * that is not told could start the same work again or report a result it
 * never got (lifecycle-grid-hunt round 3, R3-M27; Claude Code re-attaches its
 * task status after a compaction).
 */
export function runningAfterCompactionReminder(runs: readonly PendingRun[]): string | undefined {
	return runs.length === 0 ? undefined : subagentResultText().runningAfterCompaction({ runs: [...runs] });
}
