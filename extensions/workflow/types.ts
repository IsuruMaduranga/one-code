/**
 * Shared shapes for the workflow extension. Pure types only — no runtime
 * logic, no pi imports — so every module (pure and wiring alike) can depend
 * on this file without dragging anything else in.
 */

/** The `export const meta = {...}` literal every workflow script must start with. */
export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: WorkflowPhase[];
}

export interface WorkflowPhase {
	title: string;
	detail?: string;
	model?: string;
}

/** Reasoning-effort subset shared with the subagent tool. */
export type AgentEffort = "off" | "minimal" | "low" | "medium" | "high";

/** Options accepted by the script-visible `agent(prompt, opts)` hook. */
export interface AgentCallOptions {
	label?: string;
	phase?: string;
	/** JSON Schema (top-level object) forcing structured output. */
	schema?: Record<string, unknown>;
	model?: string;
	/** Confirms a `model` that costs more per token than the session model. */
	allowExpensive?: boolean;
	effort?: AgentEffort;
	isolation?: "worktree";
	agentType?: string;
}

export interface AgentTokens {
	input: number;
	output: number;
	total: number;
}

/** What a completed agent call produced, as stored in the journal. */
export interface AgentCallResult {
	/** Final assistant text, or the validated structured object when `schema` was given. */
	value: unknown;
	tokens: AgentTokens;
	cost: number;
	/** Path of a kept worktree (uncommitted changes were left behind), if any. */
	worktreePath?: string;
}

/** The one injection point globals.ts needs: something that runs a real agent. */
export type AgentCallFn = (prompt: string, opts: AgentCallOptions) => Promise<AgentCallResult>;

/** One line of journal.jsonl. */
export interface JournalEntry {
	callIndex: number;
	hash: string;
	result: AgentCallResult;
	timestamp: number;
}

/** The frozen `budget` global exposed to scripts. */
export interface BudgetSnapshot {
	total: number | null;
	spent(): number;
	remaining(): number;
}

export type RunStatus = "running" | "completed" | "failed" | "aborted";

/** Progress events a run emits (consumed by the widget, /workflows, onUpdate). */
export interface RunProgressEvent {
	type: "log" | "phase" | "agentStart" | "agentEnd";
	text?: string;
	phase?: string;
	label?: string;
	callIndex?: number;
	tokens?: AgentTokens;
	cost?: number;
	replayed?: boolean;
}

/** A saved workflow discovered in .claude/workflows/ or ~/.claude/workflows/. */
export interface SavedWorkflow {
	name: string;
	path: string;
	meta?: WorkflowMeta;
	source: "project" | "user";
}

export class WorkflowScriptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowScriptError";
	}
}
