# Command and keyboard reference

[← One Code user guide](README.md)

A lookup for every slash command, keyboard shortcut, command-line flag,
environment variable, and file location. Each entry points to the page
that explains it.

## Slash commands

### One Code commands

| Command | What it does | Page |
|---|---|---|
| `/doctor` | Run the checkup: the model reviews the measured setup report and proposes repairs. | [Doctor](doctor.md) |
| `/doctor report` | Show the report alone in a scrollable panel. | [Doctor](doctor.md) |
| `/doctor presets` | Show the three model presets and what each would pick. | [Doctor](doctor.md#model-presets) |
| `/doctor preset <economical\|balanced\|quality>` | Apply a preset. | [Doctor](doctor.md#model-presets) |
| `/agents` | Open the live subagent panel, or list the available agents. | [Subagents](subagents-and-workflows.md) |
| `/subagent <provider/model-id>` | Save the default model for subagents and workflow agents. | [Subagents](subagents-and-workflows.md#choose-the-subagent-model) |
| `/subagent inherit` | Use the main model for subagents. | |
| `/subagent status` | Show the configured default and what it resolves to. | |
| `/subagent clear` | Return to automatic selection. | |
| `/subagent` | Open a model picker. | |
| `/workflows` | Open the workflow run viewer. | [Workflows](subagents-and-workflows.md#the-run-viewer) |
| `/workflows stop <runId>` | Stop a running workflow. | |
| `/workflows log <runId>` | Print a run's recent events. | |
| `/workflows list` | List this session's runs and the saved workflows. | |
| `/effort [level]` | Set the reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`), or open the slider. | [Reasoning effort](subagents-and-workflows.md#reasoning-effort) |
| `/skills` | Manage which skills the model sees. | [Skills](skills-plugins-and-mcp.md#manage-skills) |
| `/<skill-name> [args]` | Run a skill. | [Skills](skills-plugins-and-mcp.md#skills) |
| `/skill:<name>`, `/skill:<plugin>:<name>` | Run a skill by its full name. | |
| `/<command-name> [args]` | Run a custom command from `.claude/commands/`. | [Custom commands](skills-plugins-and-mcp.md#custom-commands) |
| `/<plugin>:<command>` | Run a plugin command. | |
| `/plugins` | Browse, install, and toggle plugins and marketplaces. | [Plugins](skills-plugins-and-mcp.md#plugins) |
| `/mcp` | Manage MCP servers: status, reconnect, authenticate, enable, disable. | [MCP servers](skills-plugins-and-mcp.md#manage-servers) |
| `/lsp` | Show language-server status. | [Language servers](configuration.md#language-server-diagnostics) |
| `/permissions` | Open the permissions panel: approve calls auto mode denied, and manage rules, auto-mode rules, and workspace directories. | [Manage permissions in the panel](permissions-modes-and-auto-mode.md#manage-permissions-in-the-panel) |
| `/add-dir [path]` | Add a workspace directory, for this session or remembered. | [Workspace directories](permissions-modes-and-auto-mode.md#workspace-directories) |
| `/allow <rule> [global]` | Save an allow rule for this repository, or for every repository with `global`. | [Add a rule](permissions-modes-and-auto-mode.md#add-a-rule-during-a-session) |
| `/auto-mode`, `/auto-mode config` | Show the effective auto-mode configuration. | [Auto mode](permissions-modes-and-auto-mode.md#configure-auto-mode) |
| `/auto-mode setup` | Draft and save an auto-mode configuration for this environment. | |
| `/auto-mode defaults` | Show the built-in environment description. | |
| `/auto-mode model [provider/model-id\|clear]` | Choose or clear the classifier model. | |
| `/memory` | Open an instruction file or the memory folder. | [Memory](sessions-and-context.md#memory) |
| `/tasks`, `/tasks hide`, `/tasks show` | Print the task list, or hide and show its widget (also **alt+t**, or **ctrl+\\** on macOS). | [Tasks](tasks-and-background-work.md#the-task-list) |
| `/background` | List background tasks. | [Background](tasks-and-background-work.md#the-background-list) |
| `/loop <interval> <task>` | Repeat a task at a fixed interval (`5m`, `2h`, `1d`, or `… every 20m`). Ask the model to stop it. | [Loops](tasks-and-background-work.md#scheduled-wake-ups-and-loops) |
| `/loop <task>` | Repeat a task, letting the model choose the pace. | |
| `/loop`, `/loop <interval>` | Run the autonomous check, or the tasks in `.claude/loop.md`, on a loop. | |
| `/tools-deferred` | List deferred tools and whether each is loaded. | [Tools](tools.md#eager-and-deferred-tools) |
| `/init` | Have the model write a `CLAUDE.md` for the project. | [CLAUDE.md](bring-your-claude-code-setup.md#project-instructions-claudemd) |
| `/clear` | Start a new session (pi's `/new`); the model is told. | [Sessions](sessions-and-context.md#start-over) |
| `/exit` | Quit (pi's `/quit`). | |

### pi commands

These come from pi and are available in every One Code session.

| Command | What it does |
|---|---|
| `/login`, `/logout` | Add or remove provider credentials. |
| `/model` | Switch the model. **ctrl+s** in the picker saves it as the startup default. |
| `/thinking` | Switch the thinking level. **ctrl+s** in the picker saves it as the startup default. Covers the same dial as `/effort`. |
| `/scoped-models` | Choose which models **ctrl+p** cycles through. |
| `/settings` | pi's preferences: theme, message delivery, and more. |
| `/compact [instructions]` | Compact the context now. |
| `/resume` | Pick a previous session. |
| `/new` | Start a new session. |
| `/name <name>` | Name the session. |
| `/session` | Show the session file, id, message count, tokens, and cost. |
| `/tree` | Jump to any point in the session and continue from there. |
| `/fork`, `/clone` | Copy the session from a message, or duplicate the current branch. |
| `/trust` | Save the project trust decision for pi's own project resources. |
| `/copy` | Copy the last reply to the clipboard. |
| `/export [file]`, `/import <file>` | Export the session to HTML or JSONL; import a JSONL session. |
| `/share` | Upload the session as a private GitHub gist. |
| `/reload` | Reload extensions, skills, prompts, themes, and context files. |
| `/hotkeys` | Show every keyboard shortcut. |
| `/changelog` | Show pi's version history. |
| `/quit` | Quit. |

## Keyboard shortcuts

### One Code

| Shortcut | What it does |
|---|---|
| **ctrl+q** (**alt+m** on Windows and WSL) | Cycle the permission mode: manual, accept edits, plan, auto. |
| **↓** (empty editor) | Focus the panel below the editor: background shells, then subagents, then workflows. |
| **ctrl+x** then **ctrl+k** | Stop every running agent (in the subagent panel). |
| **x** | Stop the selected agent, shell, or workflow (in a panel). |
| **Esc** | Leave a panel, or cancel a dialog. |
| **ctrl+c** | Close any panel. |

Panel-specific keys are listed in
[The terminal interface](terminal-interface.md#panels-opened-by-commands).

### pi

The ones you will use most; `/hotkeys` shows all of them.

| Shortcut | What it does |
|---|---|
| **shift+tab** | Cycle the thinking level. |
| **ctrl+t** | Show or hide thinking blocks. |
| **alt+t** (**ctrl+\\** on macOS) | Show or hide the task list. |
| **ctrl+o** | Expand or collapse a tool's output. |
| **ctrl+p**, **shift+ctrl+p** | Cycle models forward or backward. |
| **ctrl+l** | Open the model picker. |
| **Esc** | Interrupt the model. |
| **ctrl+c** | Clear the editor; press twice to exit. |
| **ctrl+d** | Exit when the editor is empty. |
| **Enter** while the model works | Queue a message. It reaches the model once the running tool calls finish. |
| **ctrl+x ctrl+s** | Send queued messages now: interrupt the running turn and send them, with anything in the editor, as your next prompt. Running tools are cancelled. |
| **alt+enter** (**ctrl+q** on Windows and WSL) | Queue a follow-up message while the model works. |
| **alt+↑** | Restore queued messages to the editor. |
| **ctrl+g** | Edit the prompt in your external editor. |
| **ctrl+v** | Paste an image or text. |
| **shift+enter**, **ctrl+j** | Insert a newline. |
| **ctrl+x** | Copy the last reply. |
| **PgUp**, **PgDn**, **Home**, **End** | Scroll the transcript in full-screen mode. |
| **ctrl+shift+f** | Search the transcript in full-screen mode. |
| **!** at the start of a line | Run a shell command yourself. |

Rebind keys in pi's keybindings file; see pi's documentation.

## Command-line flags

`onecode` forwards every flag to pi except `--version` and `doctor`. On the
extension install, use `pi` in place of `onecode`.

| Flag | What it does |
|---|---|
| `onecode --version`, `-v` | Print the app version and the pi version inside it. |
| `onecode doctor` | Print the setup report without starting a session. Exit 1 when no provider is ready. |
| `-p "…"`, `--print` | Run one prompt and exit. |
| `--mode json` | Emit JSON events for scripting. |
| `--mode rpc` | Speak pi's RPC protocol over stdin and stdout. |
| `-c`, `--continue` | Continue the most recent session. |
| `-r`, `--resume` | Browse and pick a session. |
| `--session <id>`, `--fork <id>` | Open or fork a specific session. |
| `--no-session` | Do not save this session. |
| `--permission-mode <mode>` | Start in `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, or `dontAsk`. |
| `--dangerously-skip-permissions` | Start in bypass mode. |
| `--add-dir <paths>` | Add workspace directories for this run, separated by `:` (`;` on Windows). |
| `--model <provider/id>` | Start on a model. Add `:<level>` to set thinking. |
| `--thinking <level>` | Start at a thinking level. |
| `--provider <name>`, `--api-key <key>` | Choose a provider and supply a key for this run. |
| `--tui-mode fullscreen` | Full-screen interface (the default under the app). |
| `--tools <list>` | Restrict the tools available. |
| `-e <source>` | Load an extra extension. |
| `--offline` | Skip network checks, including the update check. |
| `--append-system-prompt <text>` | Append to the system prompt. |
| `--verbose` | Show the full startup listing. |

## Environment variables

Set these before launching.

### One Code

| Variable | Effect |
|---|---|
| `ONECODE_STATE_DIR` | Where One Code keeps its state (default `~/.onecode`). Independent of pi's agent directory. |
| `ONECODE_NO_UPDATE_CHECK=1` | Skip the daily update check. |
| `ONECODE_DEBUG=1` | Report when a pi-internal patch in the bundled app didn't apply. |
| `AA_API_KEY` | Artificial Analysis key for measured model selection. |
| `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY` | Web-search fallback keys. |

### Claude Code compatibility toggles

The `CC_` prefix is historical; `ONECODE_`-prefixed aliases are planned.

| Variable | Effect |
|---|---|
| `CC_NO_BANNER=1` | Keep pi's header instead of the One Code banner. |
| `CC_NO_INPUT_MARKER=1` | Remove the `❯` prompt marker. |
| `CC_NO_ASSISTANT_MARKER=1` | Remove the `●` reply marker. |
| `CC_FOOTER=0` | Keep pi's footer instead of One Code's status line. |
| `CC_TURN_DURATION=0` | Remove the post-turn timing line. |
| `CC_RECAP=0` | Turn off the "while you were away" recap. |
| `CC_SESSION_TITLE=0` | Turn off the automatic session title. |
| `CC_RECAP_IDLE_MS` | Idle time before a recap, in milliseconds (default 300000). |
| `CC_COMPACTION=0` | Use pi's compaction summary instead of Claude Code's. |
| `CC_CLEAR_THINKING=0`, `=1` | Force the thinking-preservation request off or on for Anthropic models. Default: on for `api.anthropic.com` only. |
| `CC_TOTAL_TOKENS=0` | Remove the `<total_tokens>` budget line. |
| `CC_TOTAL_TOKENS_BUDGET` | The per-turn budget the line counts down from (default 15000000). |
| `CC_PROMPT_TIER=frontier\|workhorse\|cheap\|tiny` | Force a system-prompt tier. |
| `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | Give frontier models and Sonnet 5 or later the task tools, which they run without by default. |
| `CC_HOOKS_DEBUG=1` | Print hook dispatches to stderr and log decisions. |
| `CC_AUTO_MODE_DEBUG=1` | Print classifier verdicts to stderr. `2` is more verbose. |
| `CC_VERSION` | The version shown in the banner (set by the app). |
| `CC_PERMISSION_MODE` | Set by One Code to the live mode for child processes. Not an input; use `--permission-mode`. |

### pi and Claude Code variables honored

| Variable | Effect |
|---|---|
| `PI_CODING_AGENT_DIR` | pi's agent directory. The app sets `~/.onecode/agent`. |
| `PI_CACHE_RETENTION` | pi's prompt-cache lifetime. One Code sets `long` for interactive sessions unless you set it yourself. |
| `PI_OFFLINE=1` | Same as `--offline`. |
| `CLAUDE_CONFIG_DIR` | Where Claude Code's user configuration is read from. |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | `1` turns the `powershell` tool on (the default on Windows), `0` turns it off. Off Windows it needs a `pwsh` on PATH. See [Windows](windows.md). |
| `CLAUDE_CODE_GIT_BASH_PATH` | The bash that drives the `bash` tool, hooks, and background shells. Also read from the `env` block of `~/.claude/settings.json`; a non-bash binary is ignored with a warning. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Default subagent model on a Claude session. |
| `EDITOR`, `VISUAL` | Editor used by `/memory` (and pi's **ctrl+g**). |
| `SHELL` | Shell used for commands (default `/bin/sh`). |
| Provider keys | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, and the rest pi supports. |

Variables One Code sets for hooks and children: `CLAUDE_PROJECT_DIR` in a
hook's environment, `CC_PERMISSION_MODE` for child tool gates.

## Files and directories

| Path | Contents |
|---|---|
| `~/.onecode/` | One Code's state. See [What is stored under ~/.onecode](configuration.md#what-is-stored-under-onecode). |
| `~/.onecode/agent/` | pi's state under the bundled app: credentials, sessions, pi's settings, plugins. |
| `~/.claude/` | Claude Code's configuration, read only, except `projects/<slug>/memory/`. |
| `~/.claude/projects/<slug>/memory/` | Per-repository memory, shared with Claude Code. |
| `.claude/` | Project configuration: `settings.json`, `settings.local.json`, `skills/`, `commands/`, `agents/`, `workflows/`, `worktrees/`. |
| `.mcp.json` | Project MCP servers. |
| `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `ONECODE.md` | Instruction files. |
| System temp directory | Session scratchpads. |

## Tools

The tools available to the model are listed in [Tools](tools.md), with the
mapping from Claude Code's names.

## Themes

`onecode` (dark) and `onecode-light`. See
[Full-screen mode and themes](configuration.md#full-screen-mode-and-themes).
