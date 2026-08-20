# One Code user guide

How to use One Code day to day. These pages cover installing it, connecting
model providers, reusing your existing Claude Code configuration, and driving
the features (subagents, workflows, permissions, and the rest). For what One
Code is and why it exists, see the [project README](../../README.md).

## Start here

If you have never run One Code, read the pages in this order:

1. [Install One Code](installation.md). Install it and open your first session.
2. [Providers and models](providers-and-models.md). Connect a provider, add an
   API key, and switch models.
3. [Bring your Claude Code setup](bring-your-claude-code-setup.md). Reuse your
   `CLAUDE.md`, skills, agents, commands, plugins, and permission rules
   unchanged.

## All guides

| Guide | What it covers |
|---|---|
| [Install One Code](installation.md) | The npm app, the pi extension, Homebrew, installing from source, and system requirements. |
| [Providers and models](providers-and-models.md) | Connecting providers, storing keys, `/model`, switching mid-session, and running a cheap model alongside a frontier one. |
| [Bring your Claude Code setup](bring-your-claude-code-setup.md) | Reusing `CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.claude/commands`, `.mcp.json`, plugins, hooks, and `settings.json`. |
| [Permissions, modes, and auto mode](permissions-modes-and-auto-mode.md) | The permission gate, cycling modes with **ctrl+q**, writing `allow`/`deny`/`ask` rules, plan mode, and auto mode. |
| [Subagents and workflows](subagents-and-workflows.md) | Delegating to subagents, background runs, git worktree isolation, and fanning work out across many agents with `ultracode`. |
| [Skills, plugins, and MCP](skills-plugins-and-mcp.md) | Running Agent Skills, installing plugins, and connecting MCP servers. |
| [Command and keyboard reference](reference.md) | Every slash command, the keyboard shortcuts, environment-variable toggles, and the two themes. |
