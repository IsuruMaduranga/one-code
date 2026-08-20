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
and the panel itself update live. The Installed "Skills" group lists **only
plugin-scope** skills — project/user skills belong to `/skills` (see below).

## The /skills panel and 4-state skill availability (2026-08-19)

One Code mirrors Claude Code's `skillOverrides` model: every project/user skill
has one of four states — `on` (name + description in the model's listing),
`name-only` (name only, saving context tokens), `user-only` (hidden from the
model, still runnable by the user via `/skill-name`), `off` (hidden, and the
Skill tool refuses it). Default is `on`. `/skills` opens a bounded panel
(`extensions/skill/panel/`: pure `state.ts` + `render.ts` + `keys.ts`, thin
`ctx.ui.custom` wiring in `index.ts`) that cycles a skill with space/enter,
searches with `/`, and sorts by name or state with `t`.

**State drives what the model sees.** `extensions/skill/index.ts` builds the
`<system-reminder>` listing from `skillListingVisibility(state)` — full / name /
hidden. The Skill tool refuses only `off`; `user-only` stays invocable (the
model just never sees it, so it won't auto-trigger — the practical equivalent of
CC's model-block, since pi registers each skill's `/skill-name` command
independently of the listing). Verified live: with states set, the real
outgoing request carried `name-only` skills as a bare name, `on` skills with
their description, and `user-only`/`off` skills absent entirely.

**Store.** `skill-overrides.json` moved from `{key: boolean}` to
`{key: SkillState}` (legacy booleans coerced: `true`→`on`, `false`→`off`).
Boolean-facing `isSkillEnabled`/`setSkillOverride` wrappers remain for callers
that only enable/disable (the plugin-skill filter in `lib/plugins.ts` and the
`/plugins` panel).

**Scope split.** Plugin skills aren't governed by `skillOverrides` (CC's rule):
`/skills` shows them locked ("managed via /plugins"), and `/plugins` now lists
only plugin-scope skills — it previously listed project/user skills too, with a
2-state toggle that would silently collapse `name-only`/`user-only`.

**The per-turn listing path.** During a turn the listing is built from
`piSkills` (pi's already-resolved skills, with descriptions) — no disk scan.
Before the first turn `piSkills` is empty, so `/skills` (and the tool's `list`)
fall back to a disk scan reading each `SKILL.md`'s frontmatter. That fallback is
what fixed a fresh session's `/skills` showing only plugin skills.

**Divergences from CC.** One Code persists to its own
`<pluginRoot>/skill-overrides.json`, never `.claude/settings.local.json` (the
isolation rule). An `off` skill's `/skill-name` command still appears in pi's
picker but the tool refuses it, where CC hides it from the picker too.

**Bounded-dock panels.** Both `/skills` and `/plugins` render as a bounded dock
via `boundedDockHeight` (`lib/tui-render.ts`), leaving the transcript visible
above rather than taking the whole window. The default `ctx.ui.custom` swaps the
editor container, so returning fewer lines than the terminal height keeps the
conversation on screen (findings §15).

## Bundled Claude Code built-in skills (2026-08-20)

**The gap.** One Code discovered only on-disk skills (`~/.claude/skills`,
`.claude/skills`, plugin skills), so Claude Code's own built-ins — `/simplify`,
`/code-review`, and the rest — never appeared. They are not files: Claude Code
compiles its built-in skills and slash commands into its Bun-built binary as
minified JS, so nothing One Code scans could ever surface them. Confirmed by
diffing a live One Code request against a Claude Code one (`git-onecode.json`
vs `git-cc-sonnet.json`): the "following skills are available" block listed 12
skills for One Code against 34 for Claude Code, and every missing one was a
built-in with no directory on disk.

**What we ship.** A bundled catalog under `skills/` (repo root, like `agents/`
and `themes/`) holding the **self-contained, provider-neutral** built-ins:
`simplify`, `code-review`, `security-review`, `fewer-permission-prompts`. Bodies
were extracted from the installed Claude Code binary and adapted — the procedure
and the extractor live in `.claude/skills/extract-cc-skills/` (internal).

**Discovery.** `extensions/claude-compat/index.ts` adds `<package>/skills`
(resolved via `import.meta.url`) to the `resources_discover` skill paths, listed
**last**: pi keeps the first-loaded skill on a name collision, so a user or
project skill of the same name wins and the bundled one is only the fallback.
`skills/` is added to `package.json` `files`.

**Adaptations (why a raw dump won't ship).** `${Ei}` already resolves to
`"Agent"`, One Code's subagent tool name. Claude Code's review skills prefer a
`ReportFindings` tool; One Code has none, so we port Claude Code's own JSON-array
fallback. `security-review`'s `!`-git prefetch does not run in a Skill-tool body
(pi expands `!` only for plugin commands), so its Phase 0 tells the model to run
the git commands itself. `fewer-permission-prompts` writes One Code's
`~/.one-code/projects/<slug>/settings.json` (via `lib/one-code-settings.ts`),
never `~/.claude`, and scans transcripts under `~/.one-code/agent/sessions`.
`code-review` folds Claude Code's per-effort prompt variants onto One Code's
`/effort` (we port the medium variant and describe the recall/precision shift)
and its `--comment`/`--fix` flag logic into the body as prose.

**Deliberately NOT ported** (kept in sync with the README "Built-in skills not
included" note): the Artifact / claude.ai-design skills, the harness/account
skills (`update-config`, `keybindings-help`, `claude-in-chrome`, `debug`,
`usage`, `setup-cowork`, `schedule`, `batch`, `claude-code-guide`), `run` /
`run-skill-generator` (One Code uses project-local run skills), and `claude-api`
(large reference, deferred). `commit`, `pr`, `loop`, `init` are already covered
by One Code's own commands and the `commit-commands` plugin.
