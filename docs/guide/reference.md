# Command and keyboard reference

A quick lookup for the slash commands, keyboard shortcuts, environment-variable
toggles, and themes.

## Slash commands

One Code adds these commands. Type them at the prompt.

| Command | What it does |
|---|---|
| `/agents` | Open the subagent panel: available agents and a live tree of running ones. |
| `/subagent` | Set the default model for subagent and workflow runs. Pass a `provider/model-id`, or `inherit`, `status`, or `clear`. |
| `/workflows` | Open the `ultracode` workflow run viewer. |
| `/effort` | Set the reasoning-effort level. |
| `/skills` | Manage which skills are available to the model. |
| `/plugins` | Browse, install, and toggle plugins. |
| `/mcp` | Manage MCP servers: status, reconnect, enable, disable. |
| `/lsp` | Show language-server status and diagnostics. |
| `/permissions` | Review the current permission rules. |
| `/allow` | Add a permission rule. |
| `/auto-mode` | View and adjust auto-mode settings. Add `setup` to run the configuration wizard. |
| `/memory` | View and edit stored memory entries. |
| `/tasks` | Open the task board. |
| `/background` | List background tasks. |
| `/loop` | Run a prompt or command on a recurring interval, or let the model pace itself. |
| `/tools-deferred` | List the tools loaded on demand behind tool search. |
| `/init` | Generate a `CLAUDE.md` for the current project. |
| `/clear` | Start a new session. |
| `/exit` | Quit One Code. |

These commands come from pi and are also available:

| Command | What it does |
|---|---|
| `/model` | Switch the active model. |
| `/login` | Connect a provider. |
| `/compact` | Compact the conversation to reclaim context. |

## Keyboard shortcuts

| Shortcut | What it does |
|---|---|
| **ctrl+q** | Cycle the permission mode: manual, accept edits, plan, auto. |
| **shift+tab** | Move the reasoning-effort dial. |
| **ctrl+x** then **ctrl+k** | Stop every running agent, from the agent panel. |

## Reasoning effort

The `/effort` command and the **shift+tab** dial set how much reasoning the
model spends, from `minimal` to `max`. One stop past `max` is `ultracode`, which
turns on parallel-agent workflows. See
[Subagents and workflows](subagents-and-workflows.md).

## Environment-variable toggles

Set these before launching to change behavior:

| Variable | Effect |
|---|---|
| `CC_NO_BANNER=1` | Restore pi's default header instead of the One Code banner. |
| `CC_CLEAR_THINKING=0` | Turn off automatic trimming of old thinking on Anthropic models. It is on by default for `api.anthropic.com`. Set to `1` to force it on elsewhere. |
| `CC_RECAP=0` | Turn off the "while you were away" recap. |
| `CC_RECAP_IDLE_MS` | Idle time in milliseconds before the recap triggers. |
| `CC_TURN_DURATION=0` | Turn off the line that reports how long a turn took. |

## Themes

Two themes ship: `one-code` (dark) and `one-code-light`. Select one through your
pi settings.

## Other run modes

The `one-code` and `pi` commands accept these flags for non-interactive use:

| Flag | What it does |
|---|---|
| `-p "…"` | Run one prompt and exit. |
| `-c` | Continue the previous session. |
| `--mode json` | Emit machine-readable events for scripting. |
| `--permission-mode plan` | Start in plan mode. |
| `--model <provider/id>` | Start on a specific model. |

On the pi-extension install, use `pi` in place of `one-code` for all of the
preceding.
