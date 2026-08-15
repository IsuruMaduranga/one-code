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

/** One tool call an agent made, kept structured so the viewer owns the formatting. */
export interface ToolActivity {
	name: string;
	/** One-line argument summary (summarizeArgs output); absent when unavailable. */
	argsSummary?: string;
}

/** Mid-run facts an executing agent reports back (resolved model, tool calls). */
export interface AgentRunUpdate {
	/** Resolved model id, known once per run. */
	model?: string;
	tool?: ToolActivity;
}

/** The one injection point globals.ts needs: something that runs a real agent. */
export type AgentCallFn = (
	prompt: string,
	opts: AgentCallOptions,
	onUpdate?: (update: AgentRunUpdate) => void,
) => Promise<AgentCallResult>;

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

/** Fields shared by every per-agent progress event. */
export interface AgentEventBase {
	callIndex: number;
	label: string;
	phase?: string;
}

/**
 * Progress events a run emits (consumed by the widget, /workflows, onUpdate).
 * A discriminated union so producers (globals.ts) and consumers (records.ts,
 * run-manager's formatEvent) agree on which fields each event carries.
 *
 * `source` marks nested-workflow provenance (the child workflow's name,
 * stamped by run-manager's runChild). A child restarts callIndex at 0, so
 * records must key on (source, callIndex), never callIndex alone.
 */
export type RunProgressEvent = (
	| { type: "log"; text: string; phase?: string }
	| { type: "phase"; phase: string }
	| ({ type: "agentStart"; prompt: string } & AgentEventBase)
	/** Mid-run update; a bare one may lack the label (records tolerates that). */
	| ({ type: "agentUpdate"; callIndex: number; label?: string; phase?: string } & AgentRunUpdate)
	| ({
			type: "agentEnd";
			tokens?: AgentTokens;
			cost?: number;
			replayed?: boolean;
			/** Replayed ends carry the prompt (there was no agentStart). */
			prompt?: string;
			/** Truncated preview of the produced value. */
			preview?: string;
			/** Failure message; presence means the agent failed. */
			text?: string;
	  } & AgentEventBase)
) & { source?: string };

/** Per-agent state folded from RunProgressEvents (viewer's detail source). */
export interface AgentRecord {
	callIndex: number;
	/** Nested workflow() provenance: the child workflow's name, if any. */
	source?: string;
	label: string;
	phase?: string;
	prompt?: string;
	model?: string;
	status: "running" | "done" | "failed" | "replayed";
	tokens?: AgentTokens;
	cost?: number;
	startedAt?: number;
	finishedAt?: number;
	/** Tool calls made, oldest first, capped. */
	activity: ToolActivity[];
	/** Truncated preview of the agent's returned value. */
	outcome?: string;
	/** Failure message when status === "failed". */
	error?: string;
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
