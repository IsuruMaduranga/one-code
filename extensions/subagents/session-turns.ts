/**
 * In-process turn tracking for a resident subagent session — the successor to
 * rpc-turns.ts's `RpcTurnTracker`, which parsed a `pi --mode rpc` child's JSONL
 * wire. Here it consumes `AgentSession.subscribe` events directly (no JSON
 * parsing, no process).
 *
 * Turn-end fires on `agent_settled`, not `agent_end`: `agent_end` can be
 * followed by an internal retry/auto-compaction/continue loop before the run is
 * really done, whereas `agent_settled` is emitted exactly once the session
 * becomes idle (see pi's AgentSession `_emitAgentSettled`). Busy/idle is read
 * from the live `AgentSession` getters, so this only accumulates per-turn stats.
 */

import { recordAction, type ChildAction } from "../auto-mode/actions.ts";
import { type ChildOutcome, OUTPUT_CAP } from "./outcome.ts";
import { addUsage, emptyUsage, type UsageTotals } from "./usage.ts";

/** The subset of AgentSession events this tracker reads. */
interface TrackedEvent {
	type?: string;
	toolName?: string;
	args?: unknown;
	message?: { role?: string; content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string };
}

export class SessionTurnTracker {
	toolCalls = 0;
	/** What the child did this turn, for auto mode's return review. */
	actions: ChildAction[] = [];
	readonly usage: UsageTotals = emptyUsage();
	/** Final assistant text of the turn in progress (or the last finished one). */
	turnText = "";
	/** Set when the turn's last assistant message ended with a provider error; cleared by a later success. */
	providerError: string | undefined;
	/** Every turn's final text joined, for task_output on a resident agent. */
	transcript = "";

	/** Call when a new turn is started (a prompt sent while idle). */
	beginTurn(): void {
		this.turnText = "";
		this.providerError = undefined;
		// Per turn, not per session: the review that reads this judges the turn just finished.
		this.actions = [];
	}

	/** Feed one subscribed event. Returns true when a turn just settled. */
	process(event: TrackedEvent): boolean {
		switch (event.type) {
			case "tool_execution_start": {
				this.toolCalls++;
				if (event.toolName) recordAction(this.actions, event.toolName, event.args);
				return false;
			}
			case "message_end": {
				if (event.message?.role !== "assistant") return false;
				addUsage(this.usage, event.message.usage);
				this.providerError =
					event.message.stopReason === "error" ? event.message.errorMessage || "unknown provider error" : undefined;
				const blocks = Array.isArray(event.message.content) ? event.message.content : [];
				const text = blocks
					.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text")
					.map((b) => b.text)
					.join("");
				if (text.trim()) this.turnText = text;
				return false;
			}
			case "agent_settled": {
				if (this.turnText.trim()) {
					this.transcript = this.transcript ? `${this.transcript}\n\n---\n\n${this.turnText}` : this.turnText;
				}
				return true;
			}
			default:
				return false;
		}
	}

	/** The outcome of the turn that just settled. */
	turnOutcome(): ChildOutcome {
		return finishOutcome(this.turnText, this.providerError, this.toolCalls, this.usage, this.actions);
	}
}

/** Shape a run/turn's collected state into a ChildOutcome, matching the spawned child's messages. */
export function finishOutcome(
	rawOutput: string,
	providerError: string | undefined,
	toolCalls: number,
	usage: UsageTotals,
	actions: ChildAction[],
): ChildOutcome {
	const output = rawOutput.slice(0, OUTPUT_CAP);
	if (providerError) {
		return {
			output: output.trim()
				? `${output}\n\n[The subagent's last request ended with a provider error: ${providerError}]`
				: `Subagent failed with a provider error (its model could not be called — an auth/billing/rate-limit problem, not a task failure): ${providerError}`,
			toolCalls,
			usage,
			actions,
			failed: true,
		};
	}
	if (output.trim()) return { output, toolCalls, usage, actions };
	return { output: "Subagent produced no output.", toolCalls, usage, actions, failed: true };
}
