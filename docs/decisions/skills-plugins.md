# Skills & plugins

Part of [Decisions](../decisions.md).

## Skills and plugins

**The `skill` tool.** pi's own skill mechanism lists skills in the system prompt
and expects the model to `read` the SKILL.md path. Claude Code instead exposes a
`Skill` tool that returns the instructions as a tool result, which is what makes
`/skill-name` invocation work. `extensions/skill/` adds that: it indexes what pi
already discovered (via `before_agent_start`'s `systemPromptOptions.skills`,
rather than rediscovering) plus plugin skills, and returns the body with the
skill's own path so relative `references/` and `scripts/` remain readable.

**Plugins.** `extensions/plugins/` reads `~/.claude/plugins/installed_plugins.json`
and wires each plugin's resources in, namespaced the way Claude Code namespaces
them so two plugins can both ship a `commit`:

| Plugin directory | Becomes |
|---|---|
| `agents/*.md` | subagents, as `<plugin>:<agent>` |
| `skills/<name>/SKILL.md` | skills, as `<plugin>:<skill>` |
| `commands/*.md` | slash commands, as `/<plugin>:<command>` |
| `.mcp.json` | MCP servers |

Command templates get full Claude Code expansion: `$ARGUMENTS`, `$@`, positional
`$1`, and **`` !`command` `` substitution**, which is what makes plugin commands
like `commit` work — the template gathers `git status` and `git diff` before the
model sees the prompt. The expanded text is delivered as a user turn.

Verified against a real installation (7 plugins): 7 namespaced agents, 3 skills
listed and invocable, 7 commands registered, 2 MCP configs picked up, and
`/commit-commands:commit` expanded with live git output embedded.

Three findings from this work, each of which had been silently wrong:

1. **Module state is not shared between extension files.** Under jiti each
   extension gets its own module instance, so a shared registry singleton written
   by one extension reads as *empty* in another — no error, just nothing. The
   deferred-tool registry only worked because its data crossed via the event bus.
   Plugin discovery is therefore a function each consumer calls for itself
   (`discoverPlugins`, memoised per module).
2. **Real frontmatter is not always valid YAML.** pi's parser threw
   "Nested mappings are not allowed in compact mappings" on a genuine plugin
   agent whose unquoted `description:` contained `: `, and our `catch` dropped the
   whole definition — the file lost this way was, aptly,
   `silent-failure-hunter.md`. `parseAgentFile` now falls back to line-wise
   extraction. Also: `model: inherit` means "use the session model", not a model
   id.
3. **Never gate a loader behind a permission prompt.** The `skill` tool was
   blocked by our own permission system in non-interactive runs, and the same
   applied to `tool_search` — which would have made every deferred tool
   unreachable by default. Both are now auto-allowed along with `lsp_diagnostics`
   and `list_mcp_resources`; network egress and MCP calls still ask. This class of
   bug was invisible because earlier end-to-end tests all ran with
   `--dangerously-skip-permissions`.

## The plugin root, the marketplace, and the /plugins panel (2026-08-19)

**Isolation: One Code never writes `~/.claude`.** All plugin state One Code
creates lives under `join(getAgentDir(), "plugins")` (`~/.one-code/agent/plugins`
in the bundled app, `~/.pi/plugins` for plain-pi installs) in Claude Code's own
file formats — `known_marketplaces.json`, `installed_plugins.json` v2,
`marketplaces/`, `cache/<mp>/<plugin>/<version>/`, `data/` — so the formats
stay interoperable even though the location doesn't. `~/.claude/plugins` and
CC's settings `enabledPlugins` are read-only inputs; CC-installed plugins keep
working read-through, and toggling one from One Code writes a local override
(`overrides.json`) applied on top during discovery, labeled "(One Code
override)" in the panel. A unit test statically enforces the boundary (no
write module references `.claude`).

**The phantom `enabled` field.** CC's `installed_plugins.json` v2 has NO
enabled field — enabled state lives in settings `enabledPlugins` (merged
user→project→local). Our old reader filtered on `entry.enabled`, a field CC
never writes; `loadInstalledPlugins` is now a dumb format reader and
`discoverPlugins` applies policy: claude-origin = `override ?? ccSettings ??
true`, one-code-origin = the entry's own `enabled` (our schema copy, where we
DO keep it). `discoverPlugins` takes a roots object (both plugin dirs + cwd +
home), unions the two origins (one-code wins on a duplicate id), and exposes
`enabledPlugins` for resource wiring — six consumer extensions updated.

**The /plugins panel** (Discover / Installed / Marketplaces / Errors) follows
the /workflows-viewer architecture: pure state machine + row models + renderer
(`extensions/plugins/panel/`), thin `ctx.ui.custom` wiring with a 500ms
ticker. Marketplaces: `add` accepts CC's grammar (owner/repo, git@, https
.git/marketplace.json, local paths); github/git sources shallow-clone
non-interactively (BatchMode SSH, GIT_TERMINAL_PROMPT=0, 120s timeout,
temp+rename so no partial clones), url sources fetch + validate the manifest;
the official `claude-plugins-official` (Apache-2.0 GitHub repo) registers
lazily on first panel open and refreshes when >24h stale — no session_start
network, no background timers, and deliberately NO `downloads.claude.ai` GCS
mirror (Anthropic service endpoint; GitHub suffices and is clearly licensed).
Install counts come from the repo's public stats JSON, cached 24h; a fetch
failure hides counts rather than showing zeros. Installs materialize
`./relative` sources out of the marketplace clone through a containment check
(manifests are third-party content) and record `{scope: "user", enabled:
true}` entries; the Installed tab adds MCP servers with live status (a
request/reply event pair with the mcp extension — jiti forbids direct state
sharing), per-skill toggles (`skill-overrides.json`, honored live by the
skill tool which refuses disabled skills by name), a lightweight usage
tracker (`usage.json`, skill + plugin-command invocations, "never used" /
"3× 12d" recency, "Not used recently" grouping), and favorites. Trust is a
static disclaimer on the detail screen — CC records no acceptance state
either.

**v1 scope cuts (all fail loudly where a manifest demands them):** npm/pip
plugin sources, commit-sha pinning, dependency resolution, policy/blocklist,
zip cache, `${user_config.*}` options flow, output styles, plugin flagging,
project/local install scopes, CC-root install/uninstall (override-toggle
only), marketplace rename. Divergences from the CC panel: favoriting lives in
the detail view so `f` stays typeable in search; Space in a search context is
reserved for toggling (never typeable — plugin names don't contain spaces);
our Installed grouping heuristic (Favorites → Needs attention → Not used
recently → Plugins → MCP → Skills) is ours, since CC's usage-recency data
doesn't exist here. Mutations show a "restart to apply" notice for MCP/
agents/hooks (their extensions snapshot discovery at startup); slash commands
and the panel itself update live.
