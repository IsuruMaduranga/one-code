/**
 * One Code's workflow text (the profile's `text.workflow`): Claude Code's
 * Workflow tool texts with One Code's tool names (description.ts), and the
 * run's results, refusals and script errors.
 */

import type { AgentFailure, AgentNotice, RunReport, RunStop, ScriptCallProblem, ScriptProblem, WorkflowRefusal, WorkflowText } from "../../extensions/workflow/text.ts";
import { workflowDescription } from "./description.ts";

function refused(refusal: WorkflowRefusal): string {
	switch (refusal.kind) {
		case "turnedOff":
			return "Workflows are turned off: enableWorkflows is false or disableWorkflows is true in One Code's user or project settings. Turn them back on there and start a new session.";
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

export const workflow: WorkflowText = {
	description: ({ guideline, configured }) => workflowDescription(guideline, configured),
	// Claude Code's parameter texts, with One Code's tool names; `name` also
	// names the personal directory, and a run is stopped with /workflows stop.
	params: ({ configDir }) => ({
		script:
			"Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
		name: `Name of a saved workflow from ${configDir}/workflows/ or ~/${configDir}/workflows/. Resolves to a self-contained script.`,
		args: "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
		scriptPath:
			"Path to a workflow script file on disk. Every workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with write/edit and re-invoke workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
		resumeFromRunId:
			"Run ID of a prior workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (/workflows stop) before resuming.",
		tokenBudget:
			"Output-token target shared by the run and nested workflows. Stops new and queued agents once reached; already-running agents may exceed it. Exposed as budget {total, spent(), remaining()}",
		sync: "Run in the foreground, blocking until the workflow finishes (default: background)",
	}),
	promptSnippet: "Run a script that orchestrates many subagents (opt-in ultracode mode)",
	// Claude Code's own arming reminder, verbatim in intent.
	ultracodeReminder: 'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.',
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
	agentPrompt: ({ prompt, structured }) =>
		structured
			? `${prompt}\n\nWhen you are done, you MUST call the \`structured_output\` tool exactly once with your final result. Its arguments are the only output the caller receives.`
			: `${prompt}\n\nThe report you hand back through SubagentHandback is returned verbatim to an orchestration script, not shown to a human — hand back the requested data/report only.`,
	structuredNudge: "You have not produced your result yet. Call the `structured_output` tool now with your final answer.",
	structuredOutputTool: {
		description: "Return the final machine-readable result for this task. Call exactly once, as your last action.",
		received: "Structured output received.",
	},
};
