# Skills, plugins, and MCP

One Code runs Agent Skills, Claude Code plugins, and MCP servers from your
existing configuration. This page covers using each and the panels that manage
them.

## Skills

An Agent Skill is a packaged set of instructions for a kind of task. One Code
discovers skills from `.claude/skills/` and lists them for the model to call.
The model invokes a skill when the task matches, or you can ask for one by name
with its slash command.

Run `/skills` to open the skills panel. Each skill can be in one of four states,
which control how it appears to the model:

- On: the model sees the skill's full description and can call it.
- Name only: the model sees the name but not the full description.
- User only: available when you invoke it, hidden from the model otherwise.
- Off: not available.

### Bundled skills

A small catalog of Claude Code's built-in skills ships with One Code so they
appear in the skill list and run the same way:

- `simplify`: clean up recently changed code for clarity.
- `code-review`: review changes for correctness bugs.
- `security-review`: review changes for security issues.
- `fewer-permission-prompts`: scan your usage and propose an allowlist.

A skill of the same name in your own `.claude/skills/` takes precedence over the
bundled one.

## Plugins

A plugin bundles agents, skills, commands, and MCP servers. One Code picks up
plugins installed under `~/.claude/plugins` and makes their contents available,
each namespaced by the plugin so names never collide with yours.

Run `/plugins` to open the marketplace panel. It has four views:

- **Discover**: browse plugins available to install.
- **Installed**: see what is installed and turn plugins on or off.
- **Marketplaces**: manage the sources plugins come from.
- **Errors**: see plugins that failed to load and why.

Plugins you install through One Code go to its own plugin directory. Plugins
Claude Code installed stay read-only; toggling one writes to an overrides layer,
never to `~/.claude`.

## MCP servers

The Model Context Protocol (MCP) lets external servers provide tools and
resources to the model. One Code connects the servers declared in your project's
`.mcp.json` on startup.

Each server's tools load on demand rather than all at once, so a server with
many tools does not bloat the prompt. The model loads a tool's full definition
when it needs it.

Run `/mcp` to open the server manager. It groups servers, shows the status of
each, and offers per-server actions to reconnect, enable, or disable a server.
Disabling a server is saved to `~/.onecode`, so it stays disabled across
sessions. Servers that need authorization support an OAuth sign-in flow that
opens your browser.

MCP tools appear to the model as `mcp__<server>__<tool>`. You do not type these
names; the model calls them.
