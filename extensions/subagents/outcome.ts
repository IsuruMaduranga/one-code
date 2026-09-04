/**
 * Shared result/handle contracts for a subagent run, plus the fork framing.
 * (These outlived child.ts, the retired process-spawning runner; the runner is
 * now in-process — see runner.ts.)
 */

import type { ChildAction } from "../auto-mode/actions.ts";
import type { UsageTotals } from "./usage.ts";

export const OUTPUT_CAP = 50_000;

/** A fork running in an isolation worktree: where it is, and where the inherited paths pointed. */
export interface ForkIsolation {
	worktreePath: string;
	parentCwd: string;
}

/**
 * Framing wrapped around a fork child's task. A fork inherits the parent's
 * entire transcript; without this, a weaker model tends to abandon its assigned
 * task and continue (or confabulate about) the inherited topic — then its output
 * returns to the parent looking like independent confirmation. See
 * docs/features/tools/records/tool-ambiguity-hardening.md (fork confabulation).
 *
 * With `isolation`, the fork is told that its working directory moved: the
 * inherited system prompt and transcript name the parent's checkout in every
 * path, so without this line a worktree fork edits the main tree (the guard in
 * lib/worktree-isolation.ts then refuses the write, but the model needs to know
 * where to write instead — SUBAGENT-REVIEW H3).
 */
export function forkTaskMessage(task: string, isolation?: ForkIsolation): string {
	const lines = [
		"You are a forked subagent. The conversation above is inherited context, for reference only — do NOT continue its open threads, verify its claims, or act on its plans. Do ONLY the task below; your final message is returned to the parent conversation verbatim, as data. You cannot see the parent's background tasks: its task ids are not addressable from here.",
	];
	if (isolation) {
		lines.push(
			"",
			`You are isolated in your own git worktree: your working directory is now ${isolation.worktreePath}, a checkout of the same repository at HEAD. Every path under ${isolation.parentCwd} in the inherited context refers to the shared checkout, which you must NOT modify — read, edit and run things at the corresponding path under ${isolation.worktreePath} instead (writes into the shared checkout are refused). Your changes stay on this worktree's branch for the parent to review.`,
		);
	}
	lines.push("", "Task:", task);
	return lines.join("\n");
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

/** A blocking run handle: await the result, or kill/snapshot it while it runs. */
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
	/**
	 * Abort any in-flight turn (reported as terminated) and dispose the session.
	 * Resolves once the abort has settled and the session is disposed (so a
	 * shutdown can wait for the exit-time cleanup, e.g. worktree removal).
	 */
	kill(): Promise<void>;
	/**
	 * Dispose an IDLE session quietly — no turn outcome, no notification. A
	 * no-op mid-turn. Its persisted session file remains, so SendMessage still
	 * reaches the agent by resuming from disk instead of live.
	 */
	release(): void;
	snapshot(): { toolCalls: number; text: string; usage: UsageTotals };
}
