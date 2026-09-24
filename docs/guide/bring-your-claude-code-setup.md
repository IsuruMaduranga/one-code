# Bring your Claude Code setup

[← One Code user guide](README.md)

One Code reads the same configuration files as Claude Code, so your
existing setup works without changes. There's no import step and nothing
to convert. Open a project that already has a `.claude/` directory, and One
Code picks up each of the following as it is.

## Project instructions: CLAUDE.md

One Code loads `CLAUDE.md` files and includes them in the model's context
exactly as Claude Code does: your global `~/.claude/CLAUDE.md`, then the
`CLAUDE.md` in every directory from the filesystem root down to the working
directory, plus any `CLAUDE.local.md` beside them for private instructions.
`@path` imports are expanded in place.

If a directory has no `CLAUDE.md`, One Code uses its `AGENTS.md` instead, so
a repository that standardized on `AGENTS.md` works too. A `CLAUDE.md` takes
precedence over an `AGENTS.md` in the same directory.

To give One Code instructions that Claude Code shouldn't read, add an
`ONECODE.md`. See [ONECODE.md](sessions-and-context.md#onecodemd).

To generate a `CLAUDE.md` for a project that lacks one, run `/init`. It has
the model survey the project (build, test, and lint commands, layout,
existing AI-tool configuration), ask you about what the code can't answer,
and write the file. It never overwrites an existing `CLAUDE.md` silently.

## Skills, commands, and agents

| Directory | Becomes |
|---|---|
| `.claude/skills/`, `~/.claude/skills/`, `~/.agents/skills/` | Skills the model can call and you can run as `/<name>`. `/skills` manages them. |
| `.claude/commands/`, `~/.claude/commands/` | Slash commands with the same names, with `$ARGUMENTS` substitution. |
| `.claude/agents/`, `~/.claude/agents/` | Subagent definitions with their model, tools, and instructions. `/agents` lists them. |
| `.claude/workflows/`, `~/.claude/workflows/` | Saved `ultracode` workflow scripts. |

See [Skills, plugins, and MCP](skills-plugins-and-mcp.md) and
[Subagents and workflows](subagents-and-workflows.md).

## Plugins

Plugins installed under `~/.claude/plugins` are picked up, with their
agents, skills, commands, hooks, MCP servers, and language-server
configuration, each namespaced by plugin. The `enabledPlugins` key in your
settings files is honored. `/plugins` browses and installs more; anything
One Code installs goes to its own plugin directory. See
[Plugins](skills-plugins-and-mcp.md#plugins).

## MCP servers

Servers in `.mcp.json`, in `~/.claude.json`, and in
`.claude/settings.local.json` are connected at startup, after a one-time
approval for project servers. Only the `mcpServers` key of `~/.claude.json`
is read; the rest of that file is left alone. See
[MCP servers](skills-plugins-and-mcp.md#mcp-servers).

## Settings files

One Code reads these Claude Code files and never writes them:

| File | Scope |
|---|---|
| `~/.claude/settings.json` | User |
| `.claude/settings.json` | Project |
| `.claude/settings.local.json` | Project, local |
| Managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, the Linux equivalent elsewhere) | Organization |
| `~/.claude.json` | User, `mcpServers` only |

`CLAUDE_CONFIG_DIR` relocates the user-scope files, as it does in Claude
Code.

The keys One Code honors:

| Key | Scopes | Notes |
|---|---|---|
| `permissions.allow`, `permissions.deny`, `permissions.ask` | All | Project allow rules need one-time approval. See [Permissions](permissions-modes-and-auto-mode.md#permission-rules). |
| `permissions.defaultMode` | All | A project file can't select `auto` or `bypassPermissions`. |
| `permissions.disableBypassPermissionsMode` | All | `"disable"` refuses bypass mode from any source. |
| `permissions.additionalDirectories` | All | Project directories need one-time approval. See [Workspace directories](permissions-modes-and-auto-mode.md#workspace-directories). |
| `autoMode.*` | User, managed | Never read from project files. See [Configure auto mode](permissions-modes-and-auto-mode.md#configure-auto-mode). |
| `hooks` | All | Project hooks need one-time approval. See [Hooks](hooks.md). |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | User, managed | The only `env` key read. |
| `enabledPlugins` | All | Later scope wins per plugin. |
| `enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers` | User, untracked local | Never from a checked-in project file. |
| `mcpServers` | `~/.claude.json`, `.claude/settings.local.json` | |

Not honored: other `env` keys,
`includeCoAuthoredBy`, `apiKeyHelper`, `forceLoginMethod`,
`cleanupPeriodDays`, and `spinnerTipsEnabled`. Run `/doctor report` to see,
for every file found, which keys were used, ignored, or refused.

## Permission rules

The `allow`, `deny`, and `ask` rules in your settings drive the permission
gate, with `deny` always winning. Claude Code's PascalCase tool names
(`Read`, `Bash`, `Edit`, `Task`, `WebFetch`, and the rest) are accepted
verbatim and mapped to the matching tool. See
[Permissions, modes, and auto mode](permissions-modes-and-auto-mode.md).

## Hooks

Claude Code command hooks run unchanged, with the same standard-input JSON,
exit-code meaning, and output format. Eight events are supported. A
project's hooks run only after you approve them once. See [Hooks](hooks.md).

## Memory

One Code keeps per-repository memory in Claude Code's own folder,
`~/.claude/projects/<slug>/memory/`, so both tools read and write the same
memories. This is the one place One Code writes under `~/.claude`. Run
`/memory` to open memory and instruction files. See
[Memory](sessions-and-context.md#memory).

## What stays separate

One Code's own state lives in `~/.onecode`. Everything it saves (a chosen
subagent model, auto-mode options, rules added with `/allow`, disabled MCP
servers, project approvals, plan files, OAuth tokens) goes there or to a
per-repository file under it, never into your Claude Code configuration.
See [Where settings live](configuration.md#where-settings-live).

## What does not carry over

Features that need Claude Code's own hosted or desktop services aren't
available. For the full list of tools, commands, and skills that are
missing or different, see
[Differences from Claude Code](differences-from-claude-code.md).
