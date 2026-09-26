# Subagents and workflows

[← One Code user guide](README.md)

One Code delegates work in two ways: subagents for tasks that deserve their
own context window, and `ultracode` workflows for fanning a large job out
across many agents at once.

## Subagents

A subagent is a child agent with its own context window. It does its work
and returns a report, so the noise of an investigation stays out of your
main conversation.

### Where subagents come from

- Four ship with One Code: `general-purpose` (any task), `explore`
  (read-only search), `plan` (design an implementation plan), and
  `one-code-guide` (questions about One Code itself; see below).
- Markdown definitions in `.claude/agents/` (project) and
  `~/.claude/agents/` (user), each setting an agent's model, tools, and
  system prompt. A project definition wins over a user definition of the
  same name.
- Plugins can add agents, namespaced by plugin.
- `fork`, a synthetic type that copies the current conversation.

Run `/agents` with no agents running to list the catalog with each agent's
tools.

### Ask One Code about itself

Ask "can One Code…?" or "how do I…?" and the model hands the question to
`one-code-guide`, the way Claude Code uses its `claude-code-guide`. The guide
answers from this user guide and pi's own docs, both of which are installed
with One Code, so the answer matches the version you run. It never answers
from memory, and it cites the page each fact came from.

It knows your setup too: your custom skills and agents, plugins, MCP
servers, installed pi packages, and which settings you've changed. When One
Code can't do what you want, it tells you so and suggests the smallest way
to get there: an existing setting, a skill, an agent, a hook, an MCP server,
or a pi extension of your own. For an extension it shows where the file goes
and how to install it for the way you run One Code, `onecode install` for
the app or `pi install` on your own pi.

The guide can only read. It uses the shell only for read-only searches,
never edits anything, and reads its docs without asking. It runs on your
subagent model. A `one-code-guide.md` in `.claude/agents/` or
`~/.claude/agents/` replaces it.

### Run a subagent

The model delegates through the `Agent` tool. You steer it in plain
language: "use a subagent to find every call site", or "explore this with
the `explore` agent". What happens next:

- **The run starts in the background.** The model receives a task id at
  once and keeps working. The subagent's report arrives as a notification
  when it finishes, mid-turn if the model is still busy, or as a new turn
  if it's idle. In a `-p` or `--mode json` run, the subagent runs to
  completion instead and the report is returned inline.
- **You can keep talking to the model** while agents run.
- **Subagents go through your permission gate.** A subagent's tool calls
  are decided by the same mode, rules, and classifier as the main session,
  and a prompt it triggers is shown to you. Your hooks run inside subagents
  too.
- **A finished agent can be messaged later.** The `SendMessage` tool
  reaches a running agent live, or resumes a finished one from its saved
  session. `list_agents` lists the session's agents and their status.

Two options change how a subagent runs:

- **Fork.** A forked subagent inherits the whole conversation so far, for a
  task that needs everything you've built up. Forks run on the main
  model and can only be started from the main conversation. Depth is
  limited: the main conversation can start a subagent, and that subagent
  one more, but no further.
- **Worktree isolation.** The subagent gets its own git worktree, branched
  from `HEAD`, so it can edit files without colliding with your working
  tree or other agents. A worktree the agent left unchanged is removed;
  otherwise it's kept and its path reported.

### Choose the subagent model

Subagents and workflow agents can run on a different model or provider
from the main session. The default is chosen for you: the cheapest model on
your provider that meets the same capability floor auto mode's classifier
uses (a Sonnet-class model for a Sonnet-class or stronger session), never a
dearer one than your main model. When an Artificial Analysis key is
configured, measured coding ability is used for that floor; see
[Automatic model selection](providers-and-models.md#automatic-model-selection).

To set the default yourself:

| Command | Effect |
|---|---|
| `/subagent <provider/model-id>` | Save a default for subagents and workflow agents. Short aliases such as `sonnet` or `haiku` work too: by name when your provider has that model, otherwise as that class within your provider. |
| `/subagent inherit` | Use the main session's model. |
| `/subagent status` | Show the configured default, the model it resolves to, and where the setting came from. |
| `/subagent clear` | Remove the saved default and return to automatic selection. |
| `/subagent` | Open a model picker. |

The choice is saved to `~/.onecode/settings.json`. A saved choice is tied
to the provider it was made on; after switching providers, run
`/subagent status` and pick again if it no longer applies.

On a Claude session, Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL` variable is
honored, from the environment or from the `env` block of your user or
managed settings. One Code's own setting wins when both are set.

An agent definition's own `model` field overrides the default for that
agent.

### Follow agents live

While agents run, the panel below the editor shows a tree: `main` first,
then each agent with its type, what it's doing right now ("Reading
src/index.ts", "Running a command"), its elapsed time, and its token count.
Nested agents appear under their parent. A finished agent stays for a few
seconds.

- Press **↓** from an empty editor to focus the rows (after the shells
  chip, if background shells exist).
- **↑** and **↓** select an agent. **Enter** opens its live transcript.
- **x** stops the selected agent. **ctrl+x** then **ctrl+k** stops all of
  them.
- In the transcript: **↑** and **↓** scroll, **PgUp** and **PgDn** page,
  **Tab** moves to the next agent, **←** returns to the rows, **Enter**
  closes the view.

`/agents` opens the panel on the newest agent.

## Git worktrees for the whole session

Separately from subagents, the model can move your whole session into an
isolated worktree with `enter_worktree`. It creates a worktree under
`.claude/worktrees/`, branched from your current `HEAD`. Every shell command
and relative path then resolves there, and your main working tree stays
untouched until `exit_worktree` leaves the worktree, keeping or removing
it. Removal is refused while there is uncommitted or unmerged work. Ask for
this when a task will make sweeping changes you want to review before
merging.

## Ultracode workflows

For a big job (a broad audit, a migration, a review worth double-checking),
include the word **`ultracode`** in your message. The model writes a short
JavaScript script that fans the work out across many agents in parallel,
then runs it with the `workflow` tool.

The keyword arms the turn it appears in. That includes a message you
queue while the model is still working: it arms once the model gets to
your message. (Queued messages need pi 0.86 or later; the `onecode` app
ships with it.) For a longer stretch of
this kind of work, turn the mode on with `/effort ultracode`: it sets the
reasoning effort to `xhigh` and keeps workflow orchestration armed until
you change the effort again. The footer shows `✦ ultracode` while it's
armed.

### How a workflow runs

- The script runs in a separate thread, so a runaway script can't freeze
  the interface. A script that stops making progress is stopped after a
  few seconds; a run is capped at 30 minutes.
- The run goes to the background and the model gets a run id. Progress
  shows in a strip below the editor (**↓** to focus it, **Enter** to open,
  **x** to stop) and in `/workflows`.
- Every completed agent call is journaled. Re-running a workflow with
  `resumeFromRunId` replays the calls whose inputs didn't change at no
  cost and runs only what differs. A background run doesn't survive the
  end of a session, but its journal does.
- A script can carry an output-token target. Once the target is reached,
  new and queued agent calls stop; agents already running finish and can
  land above it.
- Fan-out agents use the subagent default model, so a cheap subagent tier
  keeps a large run affordable while the main conversation stays on a
  frontier model.
- In a `-p` or `--mode json` run, the workflow runs to completion and
  returns its result inline.

### The run viewer

`/workflows` opens the viewer: a list of phases, the agents in each phase,
and a detail pane with each agent's prompt and output, with a live ticker.

| Key | Action |
|---|---|
| **↑**, **↓** | Move. |
| **Enter** | Open a phase or agent; expand a truncated prompt. |
| **Tab** | Switch to another running workflow. |
| **PgUp**, **PgDn** | Scroll the detail pane. |
| **x** | Stop the running workflow. |
| **s** | Save the script to `.claude/workflows/<name>.js`. A second **s** confirms an overwrite. |
| **Esc** | Go up a level, then close. **q** closes at once. |

From the prompt, `/workflows stop <runId>` stops a run, `/workflows log
<runId>` prints its recent events, and `/workflows list` prints this
session's runs and the saved workflows.

### Save a workflow to reuse

Scripts in `.claude/workflows/` (project) or `~/.claude/workflows/` (user)
can be invoked by name instead of describing the job again. A project
script shadows a user script of the same name. The viewer's **s** key saves
the current run's script there.

## Reasoning effort

`/effort` sets how much reasoning the model spends: `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`, or `ultracode`. A bare `/effort`
opens a slider (**←** and **→** or **h** and **l** move, **Enter** confirms).
Levels the current model doesn't support are skipped. **shift+tab** cycles
the plain levels; cycling away from `xhigh` while ultracode is armed turns
ultracode off.

Changing the effort re-caches the conversation, so the next request costs
more than usual. `/effort` doesn't save the level across restarts; to
save one, open pi's `/thinking` picker and press **ctrl+s**, or pass
`--thinking <level>` at launch.
