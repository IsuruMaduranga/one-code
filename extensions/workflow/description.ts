/**
 * The workflow tool's model-facing description: Claude Code's Workflow text
 * and its size-guideline line (pure).
 *
 * The authoring reference (script API, quality patterns, resume, worked
 * examples) is the bundled `workflow-authoring` skill, which the description
 * tells the model to load before writing a script. The size line follows
 * `workflowSizeGuideline` in One Code's settings (lib/one-code-settings.ts);
 * "unrestricted" sends no line, as in Claude Code. Changes from Claude Code's
 * text: the setting is named where Claude Code points to its /config row, and
 * tool names are One Code's.
 */

import type { WorkflowSizeGuideline } from "../lib/one-code-settings.ts";

export const WORKFLOW_DESCRIPTION_BODY = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** in the workflow authoring reference.
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool (if available) for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\`, a one-line \`description\` (shown in the permission dialog) and optionally \`phases\` — one \`{ title, detail? }\` per phase() call, titles matched exactly. Pass the script inline via \`script\` — do not write it to a file first, and do not also set the tool's \`name\` input (that selects a saved workflow); it is plain JavaScript, not TypeScript.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }
  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.

Before writing a script, load the \`workflow-authoring\` skill — the workflow authoring reference: script API and gotchas, resume, the **Ultracode** section, quality patterns, worked examples.`;

/** The agent count each size keeps a workflow under. */
export const WORKFLOW_SIZE_AGENTS: Record<Exclude<WorkflowSizeGuideline, "unrestricted">, number> = {
	small: 5,
	medium: 10,
	large: 50,
};

/** The size-guideline line; undefined when no guideline applies. */
export function workflowSizeLine(guideline: WorkflowSizeGuideline, configured: boolean): string | undefined {
	if (guideline === "unrestricted") return undefined;
	const opening = configured ? "A workflow size guideline is configured for this session" : "This session has the default workflow size guideline";
	return `${opening}: ${guideline} — keep workflows under ${WORKFLOW_SIZE_AGENTS[guideline]} agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale. The user can raise or remove it with \`workflowSizeGuideline\` in ~/.onecode/settings.json.`;
}

export function workflowDescription(guideline: WorkflowSizeGuideline, configured: boolean): string {
	const line = workflowSizeLine(guideline, configured);
	return line ? `${WORKFLOW_DESCRIPTION_BODY}\n\n${line}` : WORKFLOW_DESCRIPTION_BODY;
}
