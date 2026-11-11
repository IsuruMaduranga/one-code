/**
 * The workflow extension's words. The extension runs scripts (parsing, the
 * determinism guard, the agent runtime, resume, the limits) and decides
 * what happened. The profile words the tool itself, the agent prompt and
 * the ultracode reminder (`WorkflowText`); refusals, script and call
 * problems, run reports, notices and progress lines are here
 * (`workflowResultText`). Messages the
 * runtime throws into a script are worded where they are thrown, since a
 * script can read `e.message`; deep modules reach the words through
 * `words.ts`. The progress lines' glyphs (`•`, `⏳`, `✓`, `✗`) and the
 * result preview's cap are base formats.
 */

import type { WorkflowSizeGuideline } from "../../lib/profile/product-settings.ts";
import { brand } from "../../lib/profile/brand.mjs";

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
	/** A workflow agent's task: the script's prompt plus how to hand the result back. */
	agentPrompt(p: { prompt: string; structured: boolean }): string;
	structuredOutputTool: { description: string; };
}

/** The group's results, refusals and notes, which the base words (`workflowResultText`). */
export interface WorkflowResultText {
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
	/** Sent again to an agent that finished without calling structured_output. */
	structuredNudge: string;
}

function refused(refusal: WorkflowRefusal): string {
	switch (refusal.kind) {
		case "turnedOff":
			return `Workflows are turned off: enableWorkflows is false or disableWorkflows is true in ${brand.name}'s user or project settings. Turn them back on there and start a new session.`;
		case "scriptPathMissing":
			return `scriptPath ${refusal.path} does not exist`;
		case "unknownSaved":
			return `No saved workflow named "${refusal.name}". Available: ${refusal.known.join(", ") || "(none)"}`;
		case "noStoredScript":
			return `resumeFromRunId ${refusal.runId} has no stored script`;
		case "nothingToRun":
			return "Pass one of: script, scriptPath, name, or resumeFromRunId";
		case "invalidRunId":
			return `Invalid runId "${refusal.runId}"`;
		case "stillRunning":
			return `Run ${refusal.runId} is still running — stop it before resuming`;
		case "runNotFound":
			return `resumeFromRunId ${refusal.runId} not found under ${refusal.dir}`;
	}
}

const NOT_LITERAL: Record<Extract<ScriptProblem, { kind: "notLiteral" }>["detail"], string> = {
	interpolation: "must be a pure literal: template interpolation is not allowed",
	expression: "must be a pure literal: unsupported expression",
	spread: "must be a pure literal: spread is not allowed",
	spreadOrMethod: "must be a pure literal: spread/methods are not allowed",
	computedKey: "must be a pure literal: computed keys are not allowed",
	key: "must be a pure literal: unsupported key",
	other: "must be a pure literal (objects, arrays, strings, numbers, booleans)",
};

const META_FIELD: Record<Extract<ScriptProblem, { kind: "metaField" }>["field"], string> = {
	name: "`meta.name` must be a non-empty string",
	description: "`meta.description` must be a non-empty string",
	whenToUse: "`meta.whenToUse` must be a string",
	phases: "`meta.phases` must be an array",
	phaseTitle: "each entry of `meta.phases` needs a `title` string",
};

function scriptProblem(problem: ScriptProblem): string {
	switch (problem.kind) {
		case "parse":
			return `Workflow script does not parse: ${problem.osMessage}`;
		case "noMeta":
			return "Workflow scripts must begin with `export const meta = {...}`";
		case "metaBinding":
			return "The first statement must export exactly one binding named `meta`";
		case "metaNotLiteral":
			return "`meta` must be an object literal — no variables, calls, or spreads";
		case "importExport":
			return "Workflow scripts cannot use import/export beyond the leading `export const meta`";
		case "notLiteral":
			return `\`${problem.path}\` ${NOT_LITERAL[problem.detail]}`;
		case "hole":
			return `\`${problem.path}\` must not be a hole`;
		case "forbiddenKey":
			return `\`${problem.path}\` must not contain the key "${problem.key}"`;
		case "metaNotObject":
			return "`meta` must be an object literal";
		case "metaField":
			return META_FIELD[problem.field];
	}
}

function callProblem(problem: ScriptCallProblem): string {
	switch (problem.kind) {
		case "emptyPrompt":
			return "agent() needs a non-empty prompt string";
		case "schemaNotObject":
			return "agent() schema must be a JSON Schema object";
		case "unknownAgentType":
			return `agent() agentType "${problem.agentType}" is not defined. Known agents: ${problem.known.join(", ") || "(none)"}`;
		case "modelUnavailable":
			return `${problem.reason ?? `agent() model "${problem.model}" is not available.`}\n${problem.menu.join("\n")}\nAny exact provider/model-id also resolves.`;
		case "expensiveModel":
			return `${problem.gate}\nIf the user explicitly asked for this model, pass allowExpensive: true; otherwise pick a cheaper model or omit opts.model.`;
		case "noClassifierLink":
			return "agent() refused: auto mode's classifier is only reachable through the parent session, which this run has no link to";
		case "refusedByGate":
			return `agent() refused by the permission gate: ${problem.reason}`;
		case "nestedUnknown":
			return `workflow("${problem.name}"): no saved workflow with that name`;
		case "nestedPathMissing":
			return `workflow({scriptPath}): ${problem.path} does not exist`;
		case "nestedBadRef":
			return "workflow() takes a saved-workflow name or {scriptPath}";
		case "nestedTooDeep":
			return "workflow() nesting is one level only — this run cannot start another child workflow";
		case "worktreeNeedsGit":
			return 'isolation: "worktree" needs a git repository';
		case "schemaNotObjectWithProperties":
			return 'agent() schema must be a JSON Schema with top-level type "object" and properties';
	}
}

function agentFailure(failure: AgentFailure): string {
	return failure.kind === "noOutput" ? "subagent produced no output" : "subagent never produced structured output";
}

const STOPPED_BY: Record<Extract<RunStop, { kind: "stopped" }>["by"], string> = {
	toolCall: "tool call aborted",
	session: "session ended",
	command: "stopped via /workflows",
	statusStrip: "stopped from status strip",
	viewer: "stopped from viewer",
};

function runStop(stop: RunStop): string {
	switch (stop.kind) {
		case "aborted":
			return "Workflow run was aborted";
		case "agentAborted":
			return "aborted";
		case "budgetExhausted":
			return `Workflow token budget exhausted (${stop.total} output tokens)`;
		case "agentLimit":
			return `Workflow agent limit reached (${stop.max} agents per run)`;
		case "timedOut":
			return `Workflow script timed out: worker was unresponsive for ${stop.ms}ms`;
		case "scriptFailed":
			return `Workflow script failed: ${stop.message}`;
		case "workerFailed":
			return `Workflow worker failed: ${stop.message}`;
		case "workerExited":
			return `Workflow worker exited before returning a result (code ${stop.code})`;
		case "wallClock":
			return `wall-clock cap reached (${stop.minutes} minutes)`;
		case "stopped":
			return STOPPED_BY[stop.by];
	}
}

function report(run: RunReport): string {
	const statsLine = run.stats
		? `${run.stats.agents} agent(s), ${run.stats.outputTokens} output tokens, $${run.stats.cost.toFixed(4)}, ${run.seconds}s`
		: `${run.seconds}s`;
	const kept =
		run.keptWorktrees.length === 0
			? ""
			: `\n\nWorktrees kept with agents' changes or commits (review or merge them):\n${run.keptWorktrees
					.map((agent) => `- ${agent.label}: ${agent.path}${agent.branch ? ` (branch ${agent.branch})` : ""}`)
					.join("\n")}`;
	if (run.status === "completed") {
		return `Workflow **${run.name}** (${run.runId}) completed — ${statsLine}.\n\nResult:\n${run.result ?? "(script returned no value)"}${kept}`;
	}
	const tail = run.progress.join("\n");
	return `Workflow **${run.name}** (${run.runId}) ${run.status} — ${statsLine}.\nReason: ${run.reason ?? "unknown"}${tail ? `\nRecent progress:\n${tail}` : ""}\nCompleted agent calls are journaled; re-invoke the workflow tool with resumeFromRunId: "${run.runId}" to continue from where it stopped.${kept}`;
}

function notice(n: AgentNotice): string {
	const label = n.label ?? "agent";
	return n.kind === "extensionError"
		? `${label}: extension error in ${n.event}: ${n.error}`
		: `${label}: worktree kept at ${n.path} (branch ${n.branch}) with its changes or commits`;
}

/** The base's words of the group. */
export const workflowResultText: WorkflowResultText = {
	refused,
	scriptProblem,
	callProblem,
	agentFailure,
	runStop,
	determinism: {
		random: "Math.random() is unavailable in a workflow (it breaks resume); vary agent prompts by index or pass randomness in via args",
		dateNoArgs: "new Date() with no arguments is unavailable in a workflow (it breaks resume); pass timestamps in via args",
		dateCall: "Date() is unavailable in a workflow (it breaks resume); pass timestamps in via args",
		dateNow: "Date.now() is unavailable in a workflow (it breaks resume); pass timestamps in via args",
	},
	started: ({ name, resumed, runId, scriptPath }) =>
		`Workflow **${name}** ${resumed ? "resumed" : "started"} in the background.\n` +
		`runId: ${runId}\nscript: ${scriptPath}\n` +
		"The result will arrive as a task notification when the run finishes. " +
		"You know nothing about its outcome until then — do not predict it. " +
		"The user can watch with /workflows and stop with /workflows stop.",
	ranToEnd: ({ note, report: text, scriptPath }) => `${note ? `${note}\n\n` : ""}${text}\nscript: ${scriptPath}`,
	report,
	resultTruncated: "\n… (truncated)",
	defaultAgentLabel: ({ n }) => `agent ${n}`,
	notice,
	progress: {
		replayed: "(replayed)",
		outputTokens: ({ tokens }) => `${tokens} out`,
		worktreeKept: ({ path }) => `worktree kept at ${path}`,
		agentAborted: "aborted",
		agentFailed: ({ message }) => `failed: ${message}`,
	},
	structuredNudge: "You have not produced your result yet. Call the `structured_output` tool now with your final answer.",
};

/** The group's results, refusals and notes, which the base words (`workflowStructuredResultText`). */
export interface WorkflowStructuredResultText {
 received: string
}

/** The base's words of the group. */
export const workflowStructuredResultText: WorkflowStructuredResultText = {
		received: "Structured output received.",
};
