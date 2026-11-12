/**
 * What the subagents extension needs from a profile (`SubagentsText`). The
 * extension runs agents (the catalog,
 * the runtime, residents, forks, worktrees, the registry) and decides what
 * happened. The profile words the tools' descriptions and parameters, the
 * fork's framing, the delegation policy and the guide agent; the results,
 * refusals, failures and the blocks the extension adds to the conversation
 * are in lib/agents/subagent-text.ts with the data types they take, which
 * the workflow feature and lib modules read too. The hand-back tool and the model menu have their own
 * modules (lib/agents/handback-text.ts, lib/models/subagent-model-text.ts).
 * Deep modules reach the profile's part through `words.ts`.
 */

import type { DescriptionForm } from "../../lib/profile/tool-variants.ts";
import type { GuideInput } from "./guide-agent.ts";

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
