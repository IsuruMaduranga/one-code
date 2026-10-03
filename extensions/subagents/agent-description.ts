/**
 * The Agent tool's model-facing description: Claude Code's Agent text plus
 * One Code's own paragraph (pure).
 *
 * The short form goes to frontier and workhorse models, the long form (the
 * text Claude Code writes for its weakest models, with the fork guidance,
 * the briefing section and worked examples) to cheap and tiny ones
 * (lib/tool-variants.ts). Changes from Claude Code's text: a fork rejects a
 * `model` override rather than ignoring it, a missing `subagent_type` fails
 * instead of starting a general-purpose agent, agent definitions come from
 * `.claude/agents/*.md` only, and tool names are One Code's. The closing
 * paragraph describes what only One Code has: `task_output` and `task_stop`,
 * the one-shot print session, run names and `action: "list"`.
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";

export const AGENT_SHORT_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in <system-reminder> messages in the conversation.

When using the Agent tool, specify a subagent_type to select an agent: \`"fork"\` forks yourself (the fork inherits your full conversation context and always runs on your model — a \`model\` override is rejected); any other type starts a fresh agent.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

A fork runs in the background and keeps its tool output out of your context. If you are the fork, execute directly — don't re-delegate. Subagents run in the background; you'll be notified when one completes. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.

- The agent's final report is not shown to the user — relay what matters.
- Use SendMessage with the agent's ID or name to continue a previously spawned agent with its context intact; a new Agent call starts fresh (except subagent_type: "fork", which inherits your context).
- Each agent type's model, reasoning effort, and tools come from its definition (\`.claude/agents/*.md\` frontmatter).
- \`isolation: "worktree"\` gives the agent its own git worktree (auto-cleaned if unchanged).`;

export const AGENT_LONG_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in <system-reminder> messages in the conversation.

When using the Agent tool, specify a subagent_type to select an agent: \`"fork"\` forks yourself (the fork inherits your full conversation context and always runs on your model — a \`model\` override is rejected); any other type starts a fresh agent.

## Usage notes

- Always include a short description summarizing what the agent will do
- When the agent is done, its final report is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- To continue a previously spawned agent, use SendMessage with the agent's ID or name as the \`to\` field — that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs (except subagent_type: "fork"), so the prompt must be self-contained.
- Each agent type's model, reasoning effort, and tool access are set in its definition (\`.claude/agents/*.md\` frontmatter); the \`model\` parameter here overrides the definition for this one call.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since a fresh agent is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- With \`isolation: "worktree"\`, the worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.

## When to fork

Fork yourself (pass \`subagent_type: "fork"\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative — "will I need this output again" — not task size. Fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this — it inherits context and shares your cache.

Forks are cheap because they share your prompt cache.

**Don't peek.** The tool result includes an \`output_file\` path — do not read or tail it. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.


## Writing the prompt

Any agent other than a fork starts with zero context. Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

For fresh agents, terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Forking this — it's a survey question. I want the punch list, not the git output in my context.</thinking>
Agent({
  subagent_type: "fork",
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list — done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
<commentary>
Turn ends here. The coordinator knows nothing about the findings yet. What follows is a SEPARATE turn — the notification arrives from outside, as a user-role message. It is not something the coordinator writes.
</commentary>
[later turn — notification arrives as user message]
assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.
</example>

<example>
user: "so is the gate wired up or not"
<commentary>
User asks mid-wait. The audit fork was launched to answer exactly this, and it hasn't returned. The coordinator does not have this answer. Give status, not a fabricated result.
</commentary>
assistant: Still waiting on the audit — that's one of the things it's checking. Should land shortly.
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
<commentary>
A non-fork subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
Agent({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`;

/** One Code's own part, after Claude Code's text in both forms. */
export const AGENT_HOW_AGENTS_RUN = `## How agents run

- Call task_output only if your next step cannot proceed without the result (block=true waits); stop a run with task_stop. Both are deferred — load them with tool_search first.
- In a one-shot print session the call blocks and returns the report directly — no notification follows.
- Give a complete, self-contained task: the agent cannot ask follow-up questions.
- Each run gets a name — SendMessage reaches it live while it runs and continues it after it finishes. \`action: "list"\` re-prints the agent catalog.`;

/** The Agent description for a form, naming the mode's agent folder (`.onecode` in independent mode, lib/config-mode.ts). */
export function agentDescription(form: DescriptionForm, configDir = ".claude"): string {
	const base = form === "long" ? AGENT_LONG_DESCRIPTION : AGENT_SHORT_DESCRIPTION;
	return `${base.trimEnd()}\n\n${AGENT_HOW_AGENTS_RUN}`.replaceAll("`.claude/agents/*.md`", `\`${configDir}/agents/*.md\``);
}
