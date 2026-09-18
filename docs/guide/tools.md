# Tools

[← One Code user guide](README.md)

The model works by calling tools. You don't type tool names; you describe
the task and the model chooses. This page lists every tool One Code gives
the model, what each does, what you see when it runs, and how Claude Code's
tool names map onto them.

Every tool call passes through the permission gate. See
[Permissions, modes, and auto mode](permissions-modes-and-auto-mode.md).

## Eager and deferred tools

Tools come in two kinds:

- **Eager tools** are in every request. These are the tools the model uses
  constantly: `read`, `write`, `edit`, `bash`, `Agent`, `skill`,
  `ask_user_question`, `workflow`, and `tool_search`.
- **Deferred tools** are listed by name only. When the model needs one, it
  calls `tool_search` to load the full definition, and the tool stays
  available for the rest of the session. This keeps the prompt small and
  works the same way on every model tier and provider.

Run `/tools-deferred` to see which deferred tools are loaded and which are
still waiting. The list is fixed once the first request has gone out, so a
tool that appears later (an MCP server that connects slowly, for example)
is announced to the model separately.

## Files and code

| Tool | What it does |
|---|---|
| `read` | Reads a file. Shown as `● Read(path)` in the transcript. |
| `write` | Creates or overwrites a file. The model must have read an existing file in this conversation before writing it. |
| `edit` | Replaces an exact string in a file. Shown as `● Update(path)`. The same read-before-write rule applies, and the edit is refused if the file changed on disk since the model last read it. |
| `notebook_edit` | Edits a Jupyter notebook cell: replace, insert, append, or delete. Editing a code cell clears its outputs. Deferred. |
| `grep`, `find`, `ls` | pi's search tools. Active only for the smallest model tier; on other tiers, searching goes through `bash`, as in Claude Code. |

The read-before-write and stale-edit guards track file **content**, not tool
calls, so a file the model changed through a shell command is tracked too.
When a file changes outside the model's view (you edited it, a formatter
ran, a `git checkout` happened) the model is told, with the changed lines,
and must re-read the file before editing it. A file that disappears is
reported as deleted or moved.

## Shell

`bash` runs a shell command. Its `run_in_background` option starts the
command detached and returns a task id; output spools to a log file under
the session directory, and completion is reported to the model as a
notification. A background shell shows up in the shells section of the
panel below the editor. See
[Tasks and background work](tasks-and-background-work.md).

`powershell` is Claude Code's PowerShell tool: on by default on Windows,
where it becomes the primary shell and `bash` (Git Bash) stays alongside
when Git for Windows is installed; off elsewhere unless
`CLAUDE_CODE_USE_POWERSHELL_TOOL=1` and a `pwsh` is on your PATH. It has the
same `run_in_background`, the same background panel, and its description is
Claude Code's own, with the edition section (PowerShell 7 or Windows
PowerShell 5.1) picked from the executable found. Permission rules use
Claude Code's `PowerShell(...)` form. See [Windows](windows.md).

Some command shapes are refused before they run, with a message that steers
the model to a better route:

- A foreground command that starts with `sleep`, or a polling loop that
  sleeps, when the wait isn't provably short. The model is told to use
  `run_in_background` or `monitor` instead.
- A command that would orphan a process (`nohup`, `setsid`, or a trailing
  `&` with no `wait`).
- An interactive program that would stop responding without a terminal:
  `vim`, `git rebase -i`, `git add -p`, `watch`, and similar.
- Inside a worktree session, a git command aimed at a different checkout.

## Web

| Tool | What it does |
|---|---|
| `web_search` | Searches the web. Uses your provider's own search when it has one (Anthropic, OpenAI, Gemini, xAI); otherwise falls back to Brave, then Tavily, then Exa's free keyless endpoint. Results from the keyless endpoint are labelled, and the first use in a session shows a warning. See [Web search](providers-and-models.md#web-search-on-providers-without-a-search-api). Deferred. |
| `web_fetch` | Fetches a URL and converts it to readable Markdown. Follows same-host redirects; reports cross-host redirects instead of following them. Responses are cached for 15 minutes. With a `prompt`, a small reader model on your provider answers the question against the page, so the page itself stays out of your context; if the reader fails, the raw page is returned with a note. Deferred. |
| `url_context` | Gemini's page-context tool, available only when a Gemini model is in use. Deferred. |

## Delegation

| Tool | What it does |
|---|---|
| `Agent` | Starts a subagent with its own context window. Runs in the background and returns a task id; the result arrives as a notification. Supports forking the current conversation and isolating the agent in a git worktree. |
| `SendMessage` | Sends a message to an agent that was started earlier: a running one receives it live, a finished one is resumed from its saved session. Deferred. |
| `list_agents` | Lists the agents started in this session and their status. Deferred. |
| `workflow` | Runs a JavaScript script that coordinates many agents. This is the `ultracode` mechanism. |

See [Subagents and workflows](subagents-and-workflows.md).

## Planning and asking

| Tool | What it does |
|---|---|
| `enter_plan_mode`, `exit_plan_mode` | Switch into plan mode and ask you to approve the plan file. Deferred. See [Plan mode](permissions-modes-and-auto-mode.md#plan-mode). |
| `ask_user_question` | Asks you up to four structured questions in a tabbed dialog. See [The terminal interface](terminal-interface.md#the-question-dialog). |
| `skill` | Runs a skill by name. See [Skills](skills-plugins-and-mcp.md#skills). |

## Tasks and background work

| Tool | What it does |
|---|---|
| `task_create`, `task_get`, `task_list`, `task_update` | Maintain the structured task list shown in the pinned widget. Deferred. |
| `monitor` | Watches a long-running command or a WebSocket and reports each output line as an event. Deferred. |
| `task_output`, `task_stop` | Read the output of a background task or stop it. Deferred. |
| `schedule_wakeup` | Schedules a prompt for later; the mechanism behind self-paced `/loop`. Deferred. |

See [Tasks and background work](tasks-and-background-work.md).

## Worktrees

`enter_worktree` creates a git worktree under `.claude/worktrees/`, branched
from the current `HEAD`, and moves the session into it: every shell command
and relative path then resolves there, and your main working tree is
untouched. `exit_worktree` leaves it, either keeping the worktree or
removing it; removal is refused while the worktree has uncommitted or
unmerged work unless the model passes `discard_changes`. The worktrees
directory ignores itself in git. Both tools are deferred.

## Diagnostics

`lsp_diagnostics` asks a language server for the diagnostics of one file.
Separately, after every round of edits, new diagnostics from every running
server are attached to the last tool result as a `<new-diagnostics>` block,
including diagnostics in other files that the edit broke. See
[Language-server diagnostics](configuration.md#language-server-diagnostics).
Deferred.

## MCP

Every tool an MCP server provides appears as `mcp__<server>__<tool>`,
deferred until needed. `list_mcp_resources`, `read_mcp_resource`, and
`read_mcp_resource_dir` read the resources servers expose. See
[MCP servers](skills-plugins-and-mcp.md#mcp-servers).

## Tool discovery

`tool_search` loads deferred tools. The model passes exact names
(`select:monitor,task_output`), a required term (`+notebook`), or free
keywords. If the model calls a tool it hasn't loaded yet, the call fails
and the model is steered to `tool_search`.

## Behavior in non-interactive runs

In `-p` and `--mode json` runs the process exits when the turn settles, so
nothing can run in the background. Tools that would detach work run to
completion instead and return the output in their result: `bash` and
`powershell` with `run_in_background`, `Agent`, `monitor`, and `workflow`. Timers such as
`schedule_wakeup` and `/loop` never fire in these modes.

## Claude Code tool names

Claude Code's tool names are accepted in permission rules and hook
matchers, and mapped to One Code's names. Case is ignored.

| Claude Code | One Code |
|---|---|
| `Bash` | `bash` |
| `PowerShell` | `powershell` |
| `Read`, `Write`, `Edit` | `read`, `write`, `edit` |
| `Grep`, `Glob`, `LS` | `grep`, `find`, `ls` |
| `NotebookEdit` | `notebook_edit` |
| `WebFetch`, `WebSearch` | `web_fetch`, `web_search` |
| `Task`, `Agent` | `Agent` |
| `SendMessage` | `SendMessage` |
| `ListAgents` | `list_agents` |
| `Skill` | `skill` |
| `ToolSearch` | `tool_search` |
| `AskUserQuestion` | `ask_user_question` |
| `Workflow` | `workflow` |
| `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` | `task_create`, `task_get`, `task_list`, `task_update` |
| `TodoWrite` | `task_create` |
| `TaskOutput`, `TaskStop` | `task_output`, `task_stop` |
| `Monitor` | `monitor` |
| `ScheduleWakeup` | `schedule_wakeup` |
| `EnterWorktree`, `ExitWorktree` | `enter_worktree`, `exit_worktree` |
| `LSP` | `lsp_diagnostics` |
| `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool` | `list_mcp_resources`, `read_mcp_resource`, `read_mcp_resource_dir` |
| `mcp__<server>__<tool>` | Unchanged |

Claude Code tools that have no One Code equivalent are listed in
[Differences from Claude Code](differences-from-claude-code.md#tools-that-are-not-provided).
