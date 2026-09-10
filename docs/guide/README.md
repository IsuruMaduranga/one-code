# One Code user guide

How to use One Code day to day: installing it, connecting model providers,
reusing your Claude Code configuration, and driving every feature. For what
One Code is and why it exists, see the [project README](../../README.md).

## Start here

If you have never run One Code, read these in order:

1. [Install One Code](installation.md). Install it and open your first
   session.
2. [Providers and models](providers-and-models.md). Connect a provider, add
   an API key, and switch models.
3. [Bring your Claude Code setup](bring-your-claude-code-setup.md). Reuse
   your `CLAUDE.md`, skills, agents, commands, plugins, hooks, and
   permission rules unchanged.
4. [The terminal interface](terminal-interface.md). What is on screen and
   how to move around it.

## All guides

| Guide | What it covers |
|---|---|
| [Install One Code](installation.md) | The npm app, the pi extension, Homebrew, source installs, updating, and uninstalling. |
| [Providers and models](providers-and-models.md) | Connecting providers, storing keys, switching models, automatic model selection for side roles, prompt tiers, and web search. |
| [Bring your Claude Code setup](bring-your-claude-code-setup.md) | Which Claude Code files are read, which settings keys are honored, and what stays separate. |
| [The terminal interface](terminal-interface.md) | The banner, status line, working indicator, panels, dialogs, and themes. |
| [Configure One Code](configuration.md) | Settings-file locations, the `~/.onecode` layout, every One Code settings key, full-screen mode, and language servers. |
| [Permissions, modes, and auto mode](permissions-modes-and-auto-mode.md) | How decisions are made, rules, modes, the approval prompt, protected paths, project trust, plan mode, auto mode, and the security model. |
| [Hooks](hooks.md) | Supported events, the input and output contract, approval, and debugging. |
| [Subagents and workflows](subagents-and-workflows.md) | Delegating to subagents, forks, worktrees, the live panel, `ultracode` workflows, and reasoning effort. |
| [Skills, plugins, and MCP](skills-plugins-and-mcp.md) | Skills and their states, custom commands, plugins and marketplaces, and MCP servers. |
| [Tools](tools.md) | Every tool the model can call, what you see when it runs, and Claude Code's names for them. |
| [Sessions and context](sessions-and-context.md) | What the model sees, memory, compaction, the cache, recaps, and resuming sessions. |
| [Tasks and background work](tasks-and-background-work.md) | The task list, background shells, monitors, loops, and how results reach the model. |
| [Check your setup with doctor](doctor.md) | The report, the checkup, model presets, and the `onecode doctor` command. |
| [Differences from Claude Code](differences-from-claude-code.md) | What is different by design, what is not provided, and known issues. |
| [Troubleshooting](troubleshooting.md) | Symptoms, causes, and fixes. |
| [Command and keyboard reference](reference.md) | Every command, shortcut, flag, environment variable, and file location. |

## Find a setting

- [Settings files and the `~/.onecode` layout](configuration.md#where-settings-live)
- [Every One Code settings key](configuration.md#settings-reference)
- [Provider API keys](providers-and-models.md#store-keys-as-environment-variables)
- [Web-search providers and fallback order](providers-and-models.md#web-search-on-providers-without-a-search-api)
- [Subagent and classifier models](subagents-and-workflows.md#choose-the-subagent-model)
- [Default permission mode](permissions-modes-and-auto-mode.md#choose-the-starting-mode)
- [Auto-mode configuration keys](permissions-modes-and-auto-mode.md#configure-auto-mode)
- [Language-server setup](configuration.md#language-server-diagnostics)
- [Environment variables](reference.md#environment-variables)
