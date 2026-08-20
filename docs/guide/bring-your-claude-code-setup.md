# Bring your Claude Code setup

One Code reads the same configuration files as Claude Code, so your existing
setup works without changes. There is no import step and nothing to convert.
Open a project that already has a `.claude/` directory, and One Code picks up
each of the following as it is.

## Project instructions: CLAUDE.md

One Code loads `CLAUDE.md` from your project and includes it in the model's
context the same way Claude Code does. Nested `CLAUDE.md` files and `@path`
imports inside them are expanded, so a `CLAUDE.md` that imports shared
instructions keeps working.

If a directory has no `CLAUDE.md`, One Code falls back to its `AGENTS.md`. A
`CLAUDE.md` takes precedence over an `AGENTS.md` in the same directory.

To generate a `CLAUDE.md` for a project that lacks one, run `/init`. It inspects
the project and drafts the file.

## Skills

Agent Skills in `.claude/skills/` are discovered and listed for the model to
call. To see which skills are active and turn individual ones on or off, run
`/skills`. For details, see
[Skills, plugins, and MCP](skills-plugins-and-mcp.md).

## Subagents

Markdown agent definitions in `.claude/agents/` become subagents you can
delegate to. Each one keeps the model, tools, and system prompt you defined. Run
`/agents` to see them. For how to use them, see
[Subagents and workflows](subagents-and-workflows.md).

## Slash commands

Custom commands in `.claude/commands/` are available as slash commands with the
same names. Plugin commands are also available, namespaced by their plugin.

## MCP servers

MCP servers declared in `.mcp.json` are connected on startup. Each server's
tools load on demand, so they stay out of the prompt until the model needs them.
Run `/mcp` to manage servers. For details, see
[Skills, plugins, and MCP](skills-plugins-and-mcp.md).

## Plugins

Claude Code plugins installed under `~/.claude/plugins` are picked up. Their
agents, skills, commands, and MCP servers are all available, each namespaced by
plugin. Run `/plugins` to browse and install more.

One Code never writes to `~/.claude`. Plugins you install through One Code go to
its own plugin directory, and plugins Claude Code installed stay read-only,
toggled through a separate overrides layer.

## Permission rules

The `allow`, `deny`, and `ask` rules in `.claude/settings.json` drive the
permission gate, with `deny` always winning. Claude Code's PascalCase tool names
in those rules (`Read`, `Bash`, `Edit`, `Task`, `WebFetch`, and the rest) are
accepted verbatim and mapped to the matching tool. See
[Permissions, modes, and auto mode](permissions-modes-and-auto-mode.md).

## Hooks

Claude Code command hooks run unchanged, including `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, and `Stop`. They use the same standard-input
JSON, exit-code meaning, and output format. A project's hooks run only after you
approve them once.

## Memory

One Code keeps per-repository memory in the same layout Claude Code uses, keyed
by the git root. Run `/memory` to view and edit stored memory entries. One Code
adds its own configuration under `~/.onecode` and never modifies `~/.claude`.

## What stays separate

One Code keeps its own state in `~/.onecode` (or your pi agent directory) and
treats `~/.claude` as read-only. Your Claude Code settings are read, never
rewritten. One Code's own settings (such as a chosen subagent model or
auto-mode options) are stored in `~/.onecode/settings.json` or a per-repository
settings file, not mixed into your Claude Code configuration.
