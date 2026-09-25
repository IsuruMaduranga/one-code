/**
 * Cron jobs for subagents, Claude Code's way (findings §21): a subagent's
 * `cron_create` stamps its task id on the job, `cron_list` shows it only its
 * own jobs, `cron_delete` refuses another's, and a fire goes to that agent
 * while it lives and is dropped once it has ended.
 *
 * Children never load the background extension, so the subagents extension
 * gives each child proxy tools (`agentCronTools`) that reach the main
 * session's store over the main session's bus: an `AgentCronRequest` on
 * AGENT_CRON_CHANNEL, answered synchronously by the background extension. A
 * fire for an agent's job goes the other way as an `AgentCronFire` on
 * AGENT_CRON_FIRE_CHANNEL; the subagents extension sets `delivered` when the
 * agent took it.
 *
 * Pure: no pi imports.
 */

import {
	CRON_CREATE_DESCRIPTION,
	CRON_CREATE_PARAMETERS,
	CRON_DELETE_DESCRIPTION,
	CRON_DELETE_PARAMETERS,
	CRON_LIST_DESCRIPTION,
	CRON_LIST_PARAMETERS,
} from "../background/cron.ts";

export const AGENT_CRON_CHANNEL = "one-code:agent-cron";
export const AGENT_CRON_FIRE_CHANNEL = "one-code:agent-cron-fire";

export type AgentCronRequest =
	| { op: "create"; agentId: string; cwd: string; cron: string; prompt: string; recurring?: boolean; result?: AgentCronResult }
	| { op: "list"; agentId: string; result?: AgentCronResult }
	| { op: "delete"; agentId: string; id: string; result?: AgentCronResult };

export interface AgentCronResult {
	text: string;
	isError?: boolean;
	details?: Record<string, unknown>;
}

export interface AgentCronFire {
	agentId: string;
	jobId: string;
	prompt: string;
	/** Set by the subagents extension when a live agent received it. */
	delivered?: boolean;
}

/**
 * cron_create's refusal in an agent that runs to completion (a nested spawn,
 * or any spawn in a one-shot run): a fire reaches only a background agent,
 * and this one ends first.
 */
export const BLOCKING_RUN_REFUSAL =
	"Nothing was scheduled: this agent runs until its task is done and then ends, so a job it schedules could never fire. Do the work now, or report back so the main session can schedule it.";

/** Claude Code's refusal when an agent deletes a job it does not own. */
export function formatNotOwner(id: string): string {
	return `Cannot delete cron job '${id}': owned by another agent`;
}

interface Emitter {
	emit(channel: string, data: unknown): unknown;
}

/** Where a child's cron tools live: only a `resident` (background) run can receive a fire. */
export interface AgentCronOwner {
	agentId: string;
	cwd: string;
	resident: boolean;
}

/**
 * The three cron tools for a child session, bound to its owner and the MAIN
 * session's bus. Same names, schemas and descriptions as the main session's
 * (background/index.ts). A run that is not resident keeps all three, as in
 * Claude Code, but its cron_create refuses.
 */
export function agentCronTools(events: Emitter, { agentId, cwd, resident }: AgentCronOwner) {
	const toolResult = (result: AgentCronResult) => ({
		content: [{ type: "text" as const, text: result.text }],
		details: result.details ?? {},
		...(result.isError ? { isError: true } : {}),
	});
	const ask = (request: AgentCronRequest) => {
		events.emit(AGENT_CRON_CHANNEL, request);
		return toolResult(request.result ?? { text: "The session's cron store is not loaded; nothing was scheduled.", isError: true });
	};
	return [
		{
			name: "cron_create",
			label: "Cron Create",
			description: CRON_CREATE_DESCRIPTION,
			parameters: CRON_CREATE_PARAMETERS,
			async execute(_id: string, params: { cron: string; prompt: string; recurring?: boolean; durable?: boolean }) {
				if (!resident) return toolResult({ text: BLOCKING_RUN_REFUSAL, isError: true });
				return ask({ op: "create", agentId, cwd, cron: params.cron, prompt: params.prompt, recurring: params.recurring });
			},
		},
		{
			name: "cron_list",
			label: "Cron List",
			description: CRON_LIST_DESCRIPTION,
			parameters: CRON_LIST_PARAMETERS,
			async execute() {
				return ask({ op: "list", agentId });
			},
		},
		{
			name: "cron_delete",
			label: "Cron Delete",
			description: CRON_DELETE_DESCRIPTION,
			parameters: CRON_DELETE_PARAMETERS,
			async execute(_id: string, params: { id: string }) {
				return ask({ op: "delete", agentId, id: params.id });
			},
		},
	];
}
