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
	/**
	 * Set when the turn was cut short: by pi (the aborted assistant message
	 * carries `stopReason: "aborted"`), or by the runner via `markAborted` (an
	 * abort that lands during a tool call leaves no such message — the tool
	 * results just say "Operation aborted" and the loop ends). Either way the
	 * partial text must not be reported as a completion (SUBAGENT-REVIEW M3).
	 */
	aborted: string | undefined;
	/** Every turn's final text joined, for task_output on a resident agent. */
	transcript = "";

	/** Call when a new turn is started (a prompt sent while idle). */
	beginTurn(): void {
		this.turnText = "";
		this.providerError = undefined;
		this.aborted = undefined;
		// Per turn, not per session: the review that reads this judges the turn just finished.
		this.actions = [];
	}

	/** The runner cut this turn short (kill, wall-clock cap, cancelled signal); `reason` is the suffix the report carries. */
	markAborted(reason = "terminated before the turn finished"): void {
		this.aborted = reason;
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
				if (event.message.stopReason === "aborted") this.aborted ??= "terminated before the turn finished";
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
		return finishOutcome(this.turnText, this.providerError, this.toolCalls, this.usage, this.actions, this.aborted);
	}
}

/**
 * Shape a run/turn's collected state into a ChildOutcome, matching the spawned
 * child's messages. `aborted` (a reason) wins over everything: an aborted turn's
 * partial text is reported as terminated and failed, never as the answer.
 */
export function finishOutcome(
	rawOutput: string,
	providerError: string | undefined,
	toolCalls: number,
	usage: UsageTotals,
	actions: ChildAction[],
	aborted?: string,
): ChildOutcome {
	const output = rawOutput.slice(0, OUTPUT_CAP);
	if (aborted) {
		return {
			output: output.trim() ? `${output}\n\n[${aborted}]` : `Subagent ${aborted}.`,
			toolCalls,
			usage,
			actions,
			failed: true,
		};
	}
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
