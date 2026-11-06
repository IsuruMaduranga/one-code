/**
 * What the subagents extension needs from a profile (types only). The base
 * runs agents (the catalog, the runtime, residents, forks, worktrees, the
 * registry) and decides what happened; the profile words what the model
 * reads: the tools' descriptions and parameters, their results and refusals,
 * a run's failures, the fork's framing, and the blocks the extension adds to
 * the conversation. The hand-back tool and the model menu are their own
 * groups (lib/handback-text.ts, model-text.ts). Progress lines the UI shows
 * and the panels are the base's. Deep modules reach the words through
 * `words.ts`.
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";
import type { GuideInput } from "./guide-agent.ts";

/** What an agent may use, as its catalog row says. */
export type AgentTools =
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
	| { kind: "taskRequired" }
	/** A fork with a `model` or `thinking` override. */
	| { kind: "forkOverrides" }
	/** A fork in a session with no session file. */
	| { kind: "forkNotPersisted" }
	| { kind: "worktreeNeedsGit" }
	/** `reason` is the resolver's own, when it has one; `menu` the models note (model-text.ts). */
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
	/** One catalog row. */
	catalogRow(p: { name: string; description: string; tools: AgentTools }): string;
	/** The fork's catalog row. */
	forkRow: string;
	/** The Agent tool's list result. */
	catalogList(p: { rows: string[] }): string;
	/** The catalog block in the first message. */
	catalogBlock(p: { rows: string[] }): string;
	refused(refusal: SubagentRefusal): string;
	runtimeProblem(problem: RuntimeProblem): string;
	failure(failure: RunFailure): string;
	/** The note when a run fell back to the session model. */
	modelFallback(p: { model?: string; osMessage: string; fallback: string }): string;
	/** A requested run name already taken. */
	renamed(p: { wanted: string; takenBy: string; name: string }): string;
	/** An agent file whose `tools` list matches no tool. */
	unusableTools(p: { name: string; tools: string[] }): string;
	/** Creating an isolation worktree was refused; `program` names what git would run. */
	worktreeRefused(p: { program: string }): string;
	/** A worktree kept because it holds the agent's work. */
	worktreeKept(p: { path: string; branch?: string }): string;
	/** A resident running in a worktree, on its report. */
	worktreeRunning(p: { path: string; branch: string }): string;
	/** The run statistics after a report (`tokens` formatted, `cost` in dollars, both absent when unknown). */
	stats(p: { toolCalls: number; tokens?: string; cost?: number }): string;
	/** A one-shot session's inline report; `note` is the shared one-shot note. */
	inlineReport(p: { name: string; taskId: string; note: string }): string;
	/** A background launch's result. */
	launched(p: { lines: string[] }): string;
	launchLine(line: LaunchLine): string;
	sendMessageDescription: string;
	sendMessageParams: { to: string; message: string; summary: string };
	/** SendMessage results. */
	steered(p: { name: string }): string;
	nextTurn(p: { name: string }): string;
	sentToResident(p: { name: string; taskId: string }): string;
	sent(p: { name: string; taskId: string }): string;
	/** A one-shot session's inline reply; `note` is the shared one-shot note. */
	inlineReply(p: { name: string; note: string }): string;
	/** The resumed run's working directory is gone; it ran in `ranIn`. */
	relocated(p: { name: string; cwd: string; worktreeRemoved: boolean; ranIn: string }): string;
	listAgentsDescription: string;
	noAgents: string;
	agentList(p: { rows: string[] }): string;
	agentRow(p: { name: string; agent: string; status: RunStatus; taskId: string }): string;
	runStatus(status: RunStatus): string;
	/** A subagent's own SendMessage tool, to the main conversation. */
	toMain: { description: string; params: { to: string; message: string; summary: string }; delivered: string };
	/** A nested agent's message relayed to its resident parent. */
	fromSubagent(p: { name: string; summary?: string; body: string }): string;
	/** A fork's task, framed; `isolation` when it runs in its own worktree. */
	forkTask(p: { task: string; isolation?: { worktreePath: string; parentCwd: string } }): string;
	/** A fork told the parent's permission mode changed. */
	parentMode(p: { mode: string }): string;
	/** A turn ended while runs it started were still going. */
	pendingClaim(p: { runs: PendingRun[] }): string;
	/** Background runs still going after a compaction. */
	runningAfterCompaction(p: { runs: PendingRun[] }): string;
	/** The tiny tier's delegation block. */
	delegationSteer: string;
	/** A delegation block withdrawn (the model left the tiny tier). */
	delegationWithdrawn: string;
	/** Auto mode's review of a resident's actions did not finish in time. */
	reviewTimedOut: string;
	/**
	 * A built-in agent that answers questions about the product, listed below
	 * every agent file; absent, there is none. Its prompt gets the docs, the
	 * install and the user's setup (repository-supplied names filtered).
	 */
	guideAgent?: { name: string; description: string; tools: readonly string[]; systemPrompt(input: GuideInput): string };
}
