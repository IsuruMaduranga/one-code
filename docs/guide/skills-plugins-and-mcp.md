# Skills, plugins, and MCP

One Code runs Agent Skills, Claude Code plugins, and MCP servers from your
existing configuration. This page covers using each and the panels that
manage them.

## Skills

An Agent Skill is a packaged set of instructions for a kind of task. One
Code discovers skills from these places, in order of precedence:

1. `.claude/skills/` in the project
2. `~/.claude/skills/` and `~/.agents/skills/`
3. Skills from installed plugins
4. The bundled catalog

A skill of the same name earlier in the list wins.

The model calls a skill with the `skill` tool when a task matches its
description. You can also run one yourself by typing its name as a slash
command, as in Claude Code: `/simplify`, `/code-review`, or any skill from
`.claude/skills/`. Anything after the name is passed to the skill as
arguments. Plugin skills keep their plugin prefix and are run as
`/skill:<plugin>:<name>`. pi's `/skill:<name>` form works for every skill.

A skill's slash command is not created when the name is already taken by a
built-in command, a `.claude/commands/` template, or another skill.

### Manage skills

`/skills` opens the skills panel. Each skill has one of four states, which
control how the model sees it:

| State | Effect |
|---|---|
| On | The model sees the full description and can call the skill. |
| Name only | The model sees the name but not the description. |
| User only | You can run it as a command; the model does not see it. |
| Off | Not available to anyone. |

**↑** and **↓** move, **Enter** or **Space** cycle the state, **/**
searches, **t** sorts by name or state, **Esc** closes. Plugin skills are
managed from `/plugins` instead. States are saved under One Code's plugin
directory, never in the skill files.

### Bundled skills

Four of Claude Code's built-in skills ship with One Code:

- `simplify`: clean up recently changed code for clarity.
- `code-review`: review changes for correctness bugs.
- `security-review`: review changes for security issues.
- `fewer-permission-prompts`: scan your usage and propose an allowlist.

A skill of the same name in your own `.claude/skills/` takes precedence.

### Skills not bundled

The bundle omits the Claude Code skills that depend on services One Code
does not have:

| Group | Skills omitted |
|---|---|
| Hosted artifacts and design | `design`, `design-sync`, `dataviz`, the `artifact-*` guides, and the dashboard, report, table, explainer, plan, and whiteboard publishers. |
| Claude Code configuration, account, and desktop workflows | `update-config`, `keybindings-help`, `claude-in-chrome`, `debug`, `usage`, `explain-usage`, `setup-cowork`, `schedule` cloud routines, `batch`, and `claude-code-guide`. |
| Run-skill generation | `run` and `run-skill-generator`. Use project-local run skills instead. |
| API reference | `claude-api`. |

One Code provides `/init` and `/loop` itself. Commit and pull-request
workflows are available through the `commit-commands` plugin.

You can add your own skills under `.claude/skills/`. A skill that requires a
service or tool still needs that service or tool configured.

## Custom commands

Markdown files in `.claude/commands/` (project) and `~/.claude/commands/`
(user) become slash commands with the file's name, as in Claude Code.
`$ARGUMENTS` is replaced with what you type after the command. Plugin
commands are namespaced as `/<plugin>:<command>`, and may run shell
snippets from their body; oversized output is written to a file rather than
truncated.

## Plugins

A plugin bundles agents, skills, commands, hooks, MCP servers, and
language-server configuration. One Code picks up plugins installed under
`~/.claude/plugins` and makes their contents available, each namespaced by
plugin so names never collide with yours. The `enabledPlugins` key in your
Claude Code settings is honored.

Run `/plugins` to open the marketplace panel. Its four tabs are:

- **Discover**: browse plugins from your marketplaces. Type to search,
  **Space** to install, **Enter** for details.
- **Installed**: see what is installed and turn plugins, or individual
  skills within them, on or off. It works like `/skills`: **Enter** or
  **Space** toggles the selected row, **v** opens its details, **e** and
  **d** set it on or off, **u** uninstalls, **f** marks a favorite, and
  **/** opens the search box (**Esc** leaves it). MCP servers have no
  toggle, so **Enter** opens their details.
- **Marketplaces**: the sources plugins come from. **a** adds one (a GitHub
  `owner/repo`, a git URL, or a local path), **u** refreshes, **d** removes.
- **Errors**: plugins that failed to load, and why.

**←** and **→** switch tabs; **Esc** closes.

Plugins you install through One Code go to One Code's own plugin directory
under its agent directory. Plugins Claude Code installed stay read-only;
turning one off writes to an overrides layer, never to `~/.claude`.
Installing or toggling a plugin takes effect for commands at once; its MCP
servers, agents, and hooks load on the next session, and the panel says so
when you close it.

Marketplace sources are git repositories and local paths. Version pinning,
npm or pip sources, and dependency resolution are not implemented.

## MCP servers

The Model Context Protocol (MCP) lets external servers provide tools and
resources to the model. One Code reads server definitions from:

- `.mcp.json` in the project (the nearest one, walking up to the
  repository root)
- `~/.claude.json` (the `mcpServers` key)
- `.claude/settings.local.json`
- Installed plugins

Definitions may reference environment variables as `$VAR` or `${VAR}` in
the command, arguments, environment, URL, and headers; an unset variable
produces a warning. Stdio servers (`command`) and HTTP servers (`url`) are
verified; servers using server-sent events are untested.

### Approve a project's servers

Servers listed in a project's `.mcp.json` run only after you approve them.
On the first start in a project, One Code shows the servers found, with the
command each one runs, and offers to use this server, to use this and all
future servers in the project, or to decline. Approvals are stored in
`~/.onecode/mcp/project-approvals.json`, tied to the server's
configuration, so a changed command asks again. If you decline, the server
appears as disabled in `/mcp`; choosing Enable there approves it.

Claude Code's `enabledMcpjsonServers`, `disabledMcpjsonServers`, and
`enableAllProjectMcpServers` settings are honored from
`~/.claude/settings.json`, and from `.claude/settings.local.json` when that
file is not tracked by git. They are never honored from a checked-in
`.claude/settings.json`, which would let a repository approve its own
servers.

In non-interactive runs, unapproved servers are skipped with a note on
stderr.

### Use MCP tools

Each server's tools appear to the model as `mcp__<server>__<tool>` and load
on demand, so a server with many tools does not bloat the prompt. Servers
also expose resources, which the model can list and read.

A permission rule naming `mcp__<server>` covers every tool of that server.

### Manage servers

`/mcp` opens the server manager: servers grouped by source (user, project,
plugin), each with its status, tool and resource counts, and any warnings.
**Enter** on a server shows its details and a numbered action list:

- **Reconnect** restarts the connection.
- **Disable** stops the server and remembers that in `~/.onecode` (user
  scope or per repository), so it stays disabled across sessions.
  **Enable** reverses it.
- **Authenticate** appears for HTTP servers that need OAuth. It opens your
  browser for sign-in; tokens are stored under `~/.onecode/mcp-auth/` with
  owner-only permissions.

Press the action's number to run it, or **Esc** to go back.
