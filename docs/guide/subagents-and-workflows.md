# Subagents and workflows

One Code delegates work in two ways: subagents for individual tasks that deserve
their own context, and `ultracode` workflows for fanning a large job out across
many agents at once.

## Subagents

A subagent is a child agent with its own context window. It does its work and
returns only the result, so the noise of the investigation stays out of your
main conversation.

### Where subagents come from

- Definitions in `.claude/agents/`, each a markdown file that sets the
  agent's model, tools, and instructions.
- Three ship with One Code: `general-purpose`, `explore`, and `plan`.

Run `/agents` to open the live agent panel, which lists the available agents and
shows running ones as a tree with their output.

### Run a subagent

The model delegates to a subagent through the Agent tool. You steer this in
plain language, for example "use a subagent to find every call site" or "explore
this with the `explore` agent." Useful ways to run them:

- **Pick a model per agent.** Assign a cheap model to routine research and
  review so it does not spend your main model's budget. An agent definition in
  `.claude/agents/` can name its own model, and `/subagent <provider/model-id>`
  sets the default model for all subagent and workflow runs. See
  [Providers and models](providers-and-models.md).
- **Fork the current session.** A forked subagent inherits your conversation so
  far, which suits a task that needs the full context you have built up.
- **Run in the background.** Send a subagent to the background and keep working;
  message it while it runs and read its reply when it is ready.
- **Isolate in a git worktree.** Give a subagent its own worktree so it can edit
  files without colliding with your working tree or with other agents.

To stop every running agent from the panel, press **ctrl+x** then **ctrl+k**.

## Git worktrees

You can also move your whole session into an isolated git worktree, separate
from subagents. The model enters a worktree branched from your current `HEAD`
under `.claude/worktrees/`. Every command and relative path then runs there, and
your main working tree stays untouched until the session exits the worktree.
This is the safe way to let a task make sweeping changes you review before
merging.

## Ultracode workflows

For a big job (a broad audit, a migration, or a review worth double-checking),
type **`ultracode`** in your message. The model writes a short JavaScript script
that fans the work out across many agents running in parallel.

### How a workflow runs

- The run goes to the background with a live progress panel.
- Every run is journaled, so re-running a workflow replays the parts that did
  not change and only re-runs what did.
- Assign the fan-out agents a cheap model to keep a large run affordable while
  the parent stays on a frontier model.

Run `/workflows` to open the run viewer, which shows the phase and agent tree, a
detail pane for each agent's prompt and output, and a live ticker.

### Save a workflow to reuse

Save a workflow script to `.claude/workflows/` to invoke it again by name later,
instead of describing the job from scratch each time.

## Reasoning effort and ultracode

The `/effort` slider sets how much reasoning the model spends, from `minimal` to
`max`. One stop past `max` is `ultracode`, which turns on the workflow behavior
described here. Move the same dial with **shift+tab**. See
[Reasoning effort](reference.md#reasoning-effort).
