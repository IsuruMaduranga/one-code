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

import { brandedId } from "../profile/brand.mjs";
import { cronToolParameters, RECURRING_MAX_AGE_DAYS } from "./cron.ts";
import type { CronWords } from "./cron-text.ts";

export const AGENT_CRON_CHANNEL = brandedId("agent-cron");
export const AGENT_CRON_FIRE_CHANNEL = brandedId("agent-cron-fire");

export type AgentCronRequest =
	| { op: "create"; agentId: string; cwd: string; cron: string; prompt: string; recurring?: boolean; result?: AgentCronResult }
	| { op: "list"; agentId: string; result?: AgentCronResult }
	| { op: "delete"; agentId: string; id: string; result?: AgentCronResult };

export interface AgentCronResult {
	text: string;
	isError?: boolean;
	details?: Record<string, unknown>;
}

/**
 * The conversation a fire lands in: its branch to read, and entries to
 * append to it. A no-prompt `/loop` sentinel records there what it already
 * sent, so the record follows that conversation (its `/tree`, its resume,
 * its own compaction), not the session that owns the job store.
 */
export interface FireConversation {
	getBranch(): readonly unknown[];
	appendEntry(customType: string, data?: unknown): void;
}

export interface AgentCronFire {
	agentId: string;
	jobId: string;
	/**
	 * The text to send, resolved against the agent's own conversation (a
	 * sentinel reads and records its delivery there; undefined resolves as a
	 * conversation that was sent nothing). Call it once, for the send.
	 */
	text(conversation: FireConversation | undefined): string;
	/** Set by the subagents extension when a live agent received it. */
	delivered?: boolean;
}

interface Emitter {
	emit(channel: string, data: unknown): unknown;
}

/**
 * Whether `agentId` owns a pending job in the main session's store (its
 * `cron_list` count). The subagents extension keeps such an agent resident,
 * since a fire reaches only a live one.
 */
export function agentOwnsCronJobs(events: Emitter, agentId: string): boolean {
	const request: AgentCronRequest = { op: "list", agentId };
	events.emit(AGENT_CRON_CHANNEL, request);
	return ((request.result?.details?.jobCount as number | undefined) ?? 0) > 0;
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
 * (tools/background/index.ts), worded by the profile's `background.cron` group. A
 * run that is not resident keeps all three, as in Claude Code, but its
 * cron_create refuses: a fire reaches only a background agent, and a run to
 * completion (a nested spawn, or any spawn in a one-shot run) ends first.
 */
export function agentCronTools(events: Emitter, { agentId, cwd, resident }: AgentCronOwner, text: CronWords) {
	const parameters = cronToolParameters(text);
	const toolResult = (result: AgentCronResult) => ({
		content: [{ type: "text" as const, text: result.text }],
		details: result.details ?? {},
		...(result.isError ? { isError: true } : {}),
	});
	const ask = (request: AgentCronRequest) => {
		events.emit(AGENT_CRON_CHANNEL, request);
		return toolResult(request.result ?? { text: text.storeMissing, isError: true });
	};
	return [
		{
			name: "cron_create",
			label: "Cron Create",
			description: text.createDescription({ maxAgeDays: RECURRING_MAX_AGE_DAYS }),
			parameters: parameters.create,
			async execute(_id: string, params: { cron: string; prompt: string; recurring?: boolean; durable?: boolean }) {
				if (!resident) return toolResult({ text: text.blockingRunRefusal, isError: true });
				return ask({ op: "create", agentId, cwd, cron: params.cron, prompt: params.prompt, recurring: params.recurring });
			},
		},
		{
			name: "cron_list",
			label: "Cron List",
			description: text.listDescription,
			parameters: parameters.list,
			async execute() {
				return ask({ op: "list", agentId });
			},
		},
		{
			name: "cron_delete",
			label: "Cron Delete",
			description: text.deleteDescription,
			parameters: parameters.delete,
			async execute(_id: string, params: { id: string }) {
				return ask({ op: "delete", agentId, id: params.id });
			},
		},
	];
}
