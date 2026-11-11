/**
 * What the subagents extension needs from a profile (types only). The base
 * runs agents (the catalog, the runtime, residents, forks, worktrees, the
 * registry) and decides what happened; the profile words what the model
 * reads: the tools' descriptions and parameters, their results and refusals,
 * a run's failures, the fork's framing, and the blocks the extension adds to
 * the conversation. The hand-back tool and the model menu are their own
 * groups (lib/agents/handback-text.ts, lib/models/subagent-model-text.ts). Progress lines the UI shows
 * and the panels are the base's. Deep modules reach the words through
 * `words.ts`.
 */

import type { DescriptionForm } from "../../lib/profile/tool-variants.ts";
import type { CheckoutProgram } from "../../lib/shell/git-checkout-programs.ts";
import type { GuideInput } from "./guide-agent.ts";

/** What an agent may use, as its catalog row says. */
export type AgentTools =
	/** Empty when every tool the agent lists is off. */
	| { kind: "listed"; tools: string[] }
	| { kind: "allExcept"; tools: string[] }
	/** `builtIn`: a built-in or bundled agent (Claude Code writes `*` for those). */
	| { kind: "all"; builtIn: boolean };

/** A run the model started that has not reported yet. */
export interface PendingRun {
	name: string;
	taskId: string;
}

/** Why an Agent call (main or nested) or a SendMessage call was refused. */
export type SubagentRefusal =
	/** A nested call arrived before the host session was ready. */
	| { kind: "hostNotReady" }
	/** A nested call asked for a fork. */
	| { kind: "nestedFork" }
	/** A nested call passed options only the main conversation's Agent tool has. */
	| { kind: "nestedOptions"; options: string[] }
	/** A nested call named no agent (`name` absent) or an unknown one; `catalog` is the rows. */
	| { kind: "nestedUnknownAgent"; name?: string; catalog: string[] }
	| { kind: "unknownAgents"; names: string[]; catalog: string[] }
	/** No task given; `aliasNote` is the profile's note on the parameter's alias (`SubagentsText.taskAliasNote`). */
	| { kind: "taskRequired"; aliasNote: string }
	/** A fork with a `model` or `thinking` override. */
	| { kind: "forkOverrides" }
	/** A fork in a session with no session file. */
	| { kind: "forkNotPersisted" }
	| { kind: "worktreeNeedsGit" }
	/** `reason` is the resolver's own, when it has one; `menu` the models note (lib/models/subagent-model-text.ts). */
	| { kind: "unknownModel"; model: string; reason?: string; menu: string }
	/** `gate` is the expensive-model gate's sentence. */
	| { kind: "expensiveModel"; gate: string; menu: string }
	/** The parent's gate refused a nested delegation; `reason` is the gate's. */
	| { kind: "nestedDenied"; reason: string }
	/** No parent bridge to judge a nested delegation. */
	| { kind: "nestedNoBridge" }
	| { kind: "nestedCheckFailed"; osMessage: string }
	/** The runtime could not start (`problem` worded by `runtimeProblem`). */
	| { kind: "couldNotStart"; problem: string }
	/** SendMessage from the main conversation to "main". */
	| { kind: "mainIsNotRecipient" }
	/** SendMessage to a name or id no run has; `known` lists the runs. */
	| { kind: "noRun"; to: string; known: string[] }
	| { kind: "deliveryFailed"; name: string; osMessage: string }
	| { kind: "stillRunning"; name: string }
	/** A fork whose system prompt was not persisted. */
	| { kind: "forkNotResumable"; name: string }
	| { kind: "noSession"; name: string }
	| { kind: "couldNotResume"; name: string; problem: string }
	/** A subagent's SendMessage to someone other than "main"; `got` is the value as JSON. */
	| { kind: "onlyMain"; got: string }
	/** A subagent's SendMessage with no message. */
	| { kind: "messageRequired" };

/** Why the subagent runtime is not there. */
export type RuntimeProblem = { kind: "sessionEnded" } | { kind: "failed"; osMessage: string };

/** How a run ended short; `output` is what the agent wrote before it did. */
export type RunFailure =
	| { kind: "worktree"; osMessage: string }
	| { kind: "failed"; osMessage: string }
	| { kind: "turnNotStarted"; osMessage: string }
	/** The run was stopped (`stopped`) or hit the wall-clock cap (`wallClock`). */
	| { kind: "aborted"; why: "stopped" | "wallClock"; output: string }
	| { kind: "providerError"; error: string; output: string };

/** How a background launch went, one line per run in the Agent result. */
export type LaunchLine =
	| { kind: "running"; name: string; taskId: string; logPath?: string }
	| { kind: "worktreeFailed"; name: string; osMessage: string }
	| { kind: "startFailed"; name: string; osMessage: string }
	| { kind: "sessionEnded"; name: string };

/** A spawned run's status in list_agents (and the /agents fallback). */
export type RunStatus = "resident" | "running" | "finishedInline" | "finished";

export interface SubagentsText {
	/** After the error for an agent file whose `tools` list matches no tool: the names such a list may use. */
	toolNamesHint: string;
	/** In the refusal for a call without a task: the note on the alias of `task`, as a clause. */
	taskAliasNote: string;
	agentDescription(p: { form: DescriptionForm; configDir: string }): string;
	agentPromptSnippet: string;
	agentParams: {
		subagent_type: string;
		task: string;
		prompt: string;
		description: string;
		name: string;
		model: string;
		allow_expensive: string;
		thinking: string;
		isolation: string;
		action: string;
	};
	/** The Agent tool inside a non-fork child; `catalog` is the rows. */
	nestedAgentDescription(p: { catalog: string[] }): string;
	nestedAgentParams: { subagent_type: string; task: string; prompt: string; description: string; name: string };
	sendMessageDescription: string;
	sendMessageParams: { to: string; message: string; summary: string };
	listAgentsDescription: string;
	/** A subagent's own SendMessage tool, to the main conversation. */
	toMain: { description: string; params: { to: string; message: string; summary: string }; };
	/** A fork's task, framed; `isolation` when it runs in its own worktree. */
	forkTask(p: { task: string; isolation?: { worktreePath: string; parentCwd: string } }): string;
	/** The tiny tier's delegation block. */
	delegationSteer: string;
	/** A delegation block withdrawn (the model left the tiny tier). */
	delegationWithdrawn: string;
	/**
	 * A built-in agent that answers questions about the product, listed below
	 * every agent file; absent, there is none. Its prompt gets the docs, the
	 * install and the user's setup (repository-supplied names filtered).
	 */
	guideAgent?: { name: string; description: string; tools: readonly string[]; systemPrompt(input: GuideInput): string };
}

/** The group's results, refusals and notes, which the base words (`subagentToMainResultText`). */
export interface SubagentToMainResultText {
 delivered: string
}

/** The base's words of the group. */
export const subagentToMainResultText: SubagentToMainResultText = {
			delivered: "Message delivered to the main conversation.",
};
