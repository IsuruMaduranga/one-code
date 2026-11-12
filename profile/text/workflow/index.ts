/**
 * One Code's workflow words (the profile's `text.workflow`): Claude Code's
 * Workflow tool texts with One Code's tool names (description.ts), the agent
 * prompt and the ultracode reminder.
 */

import type { LiveTools, WorkflowText } from "../../../extensions/sdk/profile.ts";
import { workflowDescription } from "./description.ts";
import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

const DESCRIPTION_PASSAGES: ToolPassages = {
	Agent: [["Use the Agent tool (if available) for individual subagents, or ", "Instead, "]],
	skill: ["\n\nBefore writing a script, load the `workflow-authoring` skill — the workflow authoring reference: script API and gotchas, resume, the **Ultracode** section, quality patterns, worked examples."],
};
const PARAM_PASSAGES: ToolPassages = {
	edit: [["write/edit", "write"]],
};

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const workflowText = (live: LiveTools): WorkflowText => ({
	description: ({ guideline, configured }) => withoutOff(workflowDescription(guideline, configured), live, DESCRIPTION_PASSAGES),
	// Claude Code's parameter texts, with One Code's tool names; `name` also
	// names the personal directory, and a run is stopped with /workflows stop.
	params: ({ configDir }) => ({
		script:
			"Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
		name: `Name of a saved workflow from ${configDir}/workflows/ or ~/${configDir}/workflows/. Resolves to a self-contained script.`,
		args: "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
		scriptPath: withoutOff(
			"Path to a workflow script file on disk. Every workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with write/edit and re-invoke workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
			live,
			PARAM_PASSAGES,
		),
		resumeFromRunId:
			"Run ID of a prior workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (/workflows stop) before resuming.",
		tokenBudget:
			"Output-token target shared by the run and nested workflows. Stops new and queued agents once reached; already-running agents may exceed it. Exposed as budget {total, spent(), remaining()}",
		sync: "Run in the foreground, blocking until the workflow finishes (default: background)",
	}),
	promptSnippet: "Run a script that orchestrates many subagents (opt-in ultracode mode)",
	// Claude Code's own arming reminder, verbatim in intent.
	ultracodeReminder: 'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.',
	agentPrompt: ({ prompt, structured }) =>
		structured
			? `${prompt}\n\nWhen you are done, you MUST call the \`structured_output\` tool exactly once with your final result. Its arguments are the only output the caller receives.`
			: `${prompt}\n\nThe report you hand back through SubagentHandback is returned verbatim to an orchestration script, not shown to a human — hand back the requested data/report only.`,
	structuredOutputTool: {
		description: "Return the final machine-readable result for this task. Call exactly once, as your last action.",
	},
});
