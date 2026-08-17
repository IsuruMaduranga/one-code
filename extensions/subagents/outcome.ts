/**
 * Shared result/handle contracts for a subagent run, plus the fork framing.
 * (These outlived child.ts, the retired process-spawning runner; the runner is
 * now in-process — see runner.ts.)
 */

import type { ChildAction } from "../auto-mode/actions.ts";
import type { UsageTotals } from "./usage.ts";

export const OUTPUT_CAP = 50_000;

/**
 * Framing wrapped around a fork child's task. A fork inherits the parent's
 * entire transcript; without this, a weaker model tends to abandon its assigned
 * task and continue (or confabulate about) the inherited topic — then its output
 * returns to the parent looking like independent confirmation. See
 * docs/features/tools/records/tool-ambiguity-hardening.md (fork confabulation).
 */
export function forkTaskMessage(task: string): string {
	return [
		"You are a forked subagent. The conversation above is inherited context, for reference only — do NOT continue its open threads, verify its claims, or act on its plans. Do ONLY the task below; your final message is returned to the parent conversation verbatim, as data. You cannot see the parent's background tasks: its task ids are not addressable from here.",
		"",
		"Task:",
		task,
	].join("\n");
}

export interface ChildOutcome {
	output: string;
	toolCalls: number;
	usage: UsageTotals;
	failed?: boolean;
	/**
	 * What the child actually did, names and short subjects only. Auto mode
	 * reviews this when the child returns, to catch a sequence whose individual
	 * steps each passed. Never carries tool output — see auto-mode/actions.ts.
	 */
	actions: ChildAction[];
}

/** A foreground run handle: await the result, or kill/snapshot it while it runs. */
export interface ChildHandle {
	result: Promise<ChildOutcome>;
	kill(): void;
	snapshot(): { toolCalls: number; text: string; usage: UsageTotals };
}

/** A resident (background) agent handle: message it live, inspect it, stop it. */
export interface RpcChildHandle {
	/**
	 * Deliver a message. "started" = the agent was idle and this began a new turn;
	 * "steered" = the agent was mid-turn and the message joined it.
	 */
	send(message: string): "started" | "steered";
	busy(): boolean;
	exited(): boolean;
	kill(): void;
	snapshot(): { toolCalls: number; text: string; usage: UsageTotals };
}
