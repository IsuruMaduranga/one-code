/**
 * What the workflow extension needs from a profile (types only). The base
 * runs scripts (parsing, the determinism guard, the agent runtime, resume,
 * the limits) and decides what happened; the profile words it. Messages the
 * runtime throws into a script are worded where they are thrown, since a
 * script can read `e.message`; deep modules reach the words through
 * `words.ts`. The progress lines' glyphs (`•`, `⏳`, `✓`, `✗`) and the
 * result preview's cap are base formats.
 */

import type { WorkflowSizeGuideline } from "../../lib/profile/product-settings.ts";

/** A workflow call refused before any run starts. */
export type WorkflowRefusal =
	/** The settings turn workflows off. */
	| { kind: "turnedOff" }
	| { kind: "scriptPathMissing"; path: string }
	| { kind: "unknownSaved"; name: string; known: string[] }
	| { kind: "noStoredScript"; runId: string }
	/** None of script, scriptPath, name or resumeFromRunId. */
	| { kind: "nothingToRun" }
	| { kind: "invalidRunId"; runId: string }
	| { kind: "stillRunning"; runId: string }
	/** `dir` is where the session's runs are stored. */
	| { kind: "runNotFound"; runId: string; dir: string };

/** What is wrong with a script's source; `path` names the meta field (`meta.phases[0]`). */
export type ScriptProblem =
	| { kind: "parse"; osMessage: string }
	/** The first statement is not `export const meta = …`. */
	| { kind: "noMeta" }
	/** The first statement exports something other than one `meta` binding. */
	| { kind: "metaBinding" }
	/** `meta` is initialised with something other than an object literal. */
	| { kind: "metaNotLiteral" }
	| { kind: "importExport" }
	| { kind: "notLiteral"; path: string; detail: "interpolation" | "expression" | "spread" | "spreadOrMethod" | "computedKey" | "key" | "other" }
	| { kind: "hole"; path: string }
	| { kind: "forbiddenKey"; path: string; key: string }
	| { kind: "metaNotObject" }
	| { kind: "metaField"; field: "name" | "description" | "whenToUse" | "phases" | "phaseTitle" };

/** A script's call the runtime refuses; thrown into the script. */
export type ScriptCallProblem =
	| { kind: "emptyPrompt" }
	| { kind: "schemaNotObject" }
	| { kind: "unknownAgentType"; agentType: string; known: string[] }
	/** `reason` is the model resolver's own, when it has one; `menu` the models to pick from, as listed. */
	| { kind: "modelUnavailable"; model: string; reason?: string; menu: string[] }
	/** `gate` is the resolver's refusal of a model above the session's. */
	| { kind: "expensiveModel"; gate: string }
	/** Auto mode with no link to the parent's classifier. */
	| { kind: "noClassifierLink" }
	| { kind: "refusedByGate"; reason: string }
	| { kind: "nestedUnknown"; name: string }
	| { kind: "nestedPathMissing"; path: string }
	| { kind: "nestedBadRef" }
	/** workflow() from a run that is itself a child workflow. */
	| { kind: "nestedTooDeep" }
	/** agent() with worktree isolation outside a git repository. */
	| { kind: "worktreeNeedsGit" }
	/** agent()'s schema has no top-level object type with properties. */
	| { kind: "schemaNotObjectWithProperties" };

/** Why an agent call failed (the call resolves null; the failure shows in the progress lines). */
export type AgentFailure = { kind: "noOutput" } | { kind: "noStructuredOutput" };

/** Why a run stopped short; it becomes the report's reason. */
export type RunStop =
	| { kind: "aborted" }
	/** An agent stopped while it was asked for its structured output. */
	| { kind: "agentAborted" }
	| { kind: "budgetExhausted"; total: number }
	| { kind: "agentLimit"; max: number }
	| { kind: "timedOut"; ms: number }
	/** `message` is the script's own error. */
	| { kind: "scriptFailed"; message: string }
	| { kind: "workerFailed"; message: string }
	| { kind: "workerExited"; code: number | null }
	| { kind: "wallClock"; minutes: number }
	| { kind: "stopped"; by: "toolCall" | "session" | "command" | "statusStrip" | "viewer" };

/** Something an agent's run reported along the way (a progress line). */
export type AgentNotice =
	| { kind: "extensionError"; label?: string; event: string; error: string }
	| { kind: "worktreeKept"; label?: string; path: string; branch?: string };

/** A finished run, for its report. */
export interface RunReport {
	name: string;
	runId: string;
	status: "completed" | "failed" | "aborted";
	/** Absent when the run never got going. */
	stats?: { agents: number; outputTokens: number; cost: number };
	seconds: number;
	/** The script's value as previewed (already cut, with `resultTruncated` at the cut); undefined when it returned none. */
	result?: string;
	/** Why it stopped, for a run that did not complete. */
	reason?: string;
	/** The last progress lines, oldest first. */
	progress: string[];
	keptWorktrees: { label: string; path: string; branch?: string }[];
}

export interface WorkflowText {
	/** `configured`: the guideline comes from the user's settings, not the default. */
	description(p: { guideline: WorkflowSizeGuideline; configured: boolean }): string;
	/** `configDir` is the project config folder saved workflows live under (`.claude`). */
	params(p: { configDir: string }): { script: string; name: string; args: string; scriptPath: string; resumeFromRunId: string; tokenBudget: string; sync: string };
	promptSnippet: string;
	/** The one-shot reminder when the user's message says "ultracode". */
	ultracodeReminder: string;
	refused(refusal: WorkflowRefusal): string;
	scriptProblem(problem: ScriptProblem): string;
	callProblem(problem: ScriptCallProblem): string;
	agentFailure(failure: AgentFailure): string;
	runStop(stop: RunStop): string;
	/** The errors the determinism guard throws inside a script. */
	determinism: { random: string; dateNoArgs: string; dateCall: string; dateNow: string };
	/** A run started (or resumed) in the background. */
	started(p: { name: string; resumed: boolean; runId: string; scriptPath: string }): string;
	/** A run that ran to its end in the call; `note` is the shared one-shot note, when the run was forced to the foreground. */
	ranToEnd(p: { note?: string; report: string; scriptPath: string }): string;
	report(report: RunReport): string;
	/** Marks where a long result preview was cut. */
	resultTruncated: string;
	/** An agent call with no label: the n-th call (1-based). */
	defaultAgentLabel(p: { n: number }): string;
	notice(notice: AgentNotice): string;
	/** The words in progress lines (the glyphs are the base's). */
	progress: {
		replayed: string;
		outputTokens(p: { tokens: number }): string;
		worktreeKept(p: { path: string }): string;
		agentAborted: string;
		agentFailed(p: { message: string }): string;
	};
	/** A workflow agent's task: the script's prompt plus how to hand the result back. */
	agentPrompt(p: { prompt: string; structured: boolean }): string;
	/** Sent again to an agent that finished without calling structured_output. */
	structuredNudge: string;
	structuredOutputTool: { description: string; received: string };
}
