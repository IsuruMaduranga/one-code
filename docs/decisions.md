# Decisions

Short notes on choices that aren't obvious from the code.

## Distribution: pi package, not a wrapper binary

pi's `piConfig` rebranding (app name, config dir) resolves from pi's *own*
installed `package.json`, so a dependent package cannot rebrand it. Shipping as
a pi package (`pi install npm:pi-claude-code`) costs nothing extra and keeps
upstream pi upgrades a version bump away. All Claude-Code-shaped paths
(`.claude/settings.json`, `.claude/commands`, `.claude/agents`) are discovered
by our own code rather than by changing pi's `.pi` namespace.

## System prompt: per-turn `before_agent_start`, not a static override

`DefaultResourceLoader.systemPromptOverride` requires SDK composition (which
would mean re-implementing pi's CLI) and is fixed at resource-load time. The
`before_agent_start` event hands us `systemPromptOptions` every turn, reflecting
the currently active tool set — needed because plan mode and deferred loading
change it. The environment block is cached per (cwd, model) so the prompt stays
byte-identical across turns and provider prompt caching still pays off.

## Tool names stay pi-idiomatic (snake_case)

pi keys its built-in overrides and typed `tool_call` events on `read`, `bash`,
`edit`, `write`, `grep`, `find`, `ls`. We register custom tools in the same
style (`todo_write`, `enter_plan_mode`, `subagent`). Users' Claude Code
permission rules still work: `matcher.ts` maps `Bash`, `Glob`, `WebFetch`,
`Task`, … onto our names. pi's Anthropic OAuth mode separately renames tools to
Claude Code's casing on the wire, so nothing is lost there either.

## Community packages: adopted where they work

Per project directive, prefer ecosystem packages over new code.

- **Adopted:** `pi-ask-user` for the AskUserQuestion role (option lists,
  multi-select, freeform, headless fallback). Bundled as a dependency and
  re-exported from `extensions/ask-user`, so users get it automatically.
- **Rejected: `pi-subagents` (0.40.0).** Its child processes were SIGKILLed by
  the parent ~29 ms after spawn in this environment (macOS, Node 26,
  pi 0.83.0), in both print and RPC mode, with our extensions absent and the
  same failure when spawning through an explicit `PI_SUBAGENT_PI_BINARY`
  wrapper. The identical child command line runs fine standalone, so the fault
  is in the package's parent-side lifecycle management, not our integration.
  `extensions/subagents` is therefore our own implementation, modeled on pi's
  official `examples/extensions/subagent`: spawn `pi --mode json -p`, parse the
  event stream, return the child's final text. Worth re-evaluating the package
  on a future release.

## Deferred tools (ToolSearch)

`extensions/lib/deferred.ts` holds a registry; any extension defers its own
tools by emitting `pi-claude-code:defer-tool` on the event bus. `tool-search`
deactivates them at session start, announces the names in an every-turn
`<system-reminder>` (as Claude Code does), and activates matches additively so
pi can use native deferred loading.

**Load order is load-bearing:** `tool-search` must appear before any extension
that defers a tool, because those emit during extension loading and pi's event
bus only delivers to already-registered listeners. Deferred tools also omit
`promptSnippet`/`promptGuidelines` — activating a tool that has them rebuilds
the system prompt and invalidates the cached prefix, defeating the purpose.

Verified on OpenAI (gpt-5.5): after `tool_search`, pi injected native
`tool_search_call` / `tool_search_output` items at the load point rather than
appending the schema to the request's tool array, and the model then called the
tool successfully. The Anthropic `defer_loading` path and the non-native
fallback are pi-owned code paths that could not be exercised here (no second
provider credential configured).

## Web tools

**Search — kept as a dependency.** `web_search` comes from **`pi-web-search`**:
it calls the *current model provider's own* search API (OpenAI/Codex, Anthropic,
Gemini), so no extra API key and no scraping. At 1,610 lines with **zero runtime
dependencies**, what it encodes is knowledge — three providers' search API shapes
— rather than machinery, and tracking those ourselves would be a worse trade.
It also registers Gemini-only `url_context`. Both tools are deferred.

One coupling to preserve: pi-web-search drives `setActiveTools` to hide
`url_context` on non-Gemini models. That composes with our deferral **only
because `tool-search` loads first**, so deferred tools are already deactivated
when pi-web-search snapshots the active set.

**Fetch — replaced with our own.** `extensions/web-fetch/` (~250 lines) replaces
`pi-web-access`, which was the heaviest thing in the tree: 21,719 lines, 7.5 MB,
seven runtime dependencies, and **114 of our then-208 installed packages** — to
supply one tool we used. Its other three tools were unused, its `web_search` was
deliberately overridden, and it spawned processes for GitHub cloning, video
extraction, and reading the browser's cookie store. That is a lot of unreviewed
surface and startup weight for an HTTP GET.

Ours keeps three focused dependencies (`@mozilla/readability`, `linkedom`,
`turndown`) because HTML-to-markdown quality genuinely affects what the model
reads; a regex stripper produces poor input on real documentation. Total install
went from 208 packages to 109.

Claude Code parity notes for `web_fetch`: http is upgraded to https,
non-web schemes are refused, responses are cached 15 minutes, and cross-host
redirects are reported rather than followed (so a redirect cannot quietly take
the agent elsewhere; same-host ones are followed).

**Deliberate deviation:** Claude Code answers a `prompt` against the page using a
small fast model. pi exposes no clean in-process completion helper, and a
summarisation call that fails silently would degrade quality invisibly — the
exact failure shape we have been removing. Instead the tool returns extracted
markdown windowed to 30k characters and reports `nextOffset`, so the model reads
the page itself and can page through a long one.

## AskUserQuestion — our own

`extensions/ask-user/` replaces the community `pi-ask-user`. That package worked
and had a nicer overlay UI, but it carried two problems:

1. It pulled **`@sinclair/typebox@0.34`** — a second, different schema library,
   since pi itself uses `typebox@1.x` — and built its tool schema with it. It
   worked, but two schema implementations in one process is a silent-divergence
   risk, not a visible one.
2. It asked **one question per call**, while Claude Code's AskUserQuestion takes
   up to four questions, each with `header`, optional `multiSelect`, and 2–4
   labelled options with descriptions.

Ours matches Claude Code's schema and drops the duplicate dependency, at the cost
of a plainer presentation: pi has no native multi-question widget, so questions
are asked one dialog at a time via `ctx.ui.select`, with a `✓` marker
accumulating multi-select choices, a "Done selecting" entry, and an automatic
"Other (type your own answer)" escape hatch routed to `ctx.ui.input`. Cancelling
any question cancels the batch, since later answers are meaningless without the
earlier ones. Non-interactive sessions get an instruction to ask in the reply
instead.

Verified over RPC: a two-question call produced three dialogs — single-select,
then multi-select showing `✓ Caching` on the second pass — and returned both
answers in one structured result.

## LSP: our own client, not a package

Originally adopted **`pi-lsp-extension`** (MIT). It worked, but proved fragile in
four ways, all of which needed workarounds on our side:

1. A stale transitive import (`vscode-languageserver-protocol/node.js`, an export
   removed in 3.18) had to be pinned with an npm `override`.
2. Its language servers kept the process alive after the final turn, so `pi -p`
   **never exited**. We had to gate the whole extension off in one-shot runs,
   which meant no diagnostics there at all.
3. Its auto-append hook only fired when a server was *already* running, and
   servers started lazily on the first file **read** — so an edit as the first
   action of a session silently produced nothing.
4. Against TypeScript 7 (whose native compiler dropped `lib/tsserver.js`) the
   server failed and diagnostics **silently** degraded to tree-sitter syntax
   checks, with no signal that type checking was gone.

It also carried far more than we need: ~7000 lines and twelve tools, including
tree-sitter search, a workspace index, completions, and code actions. Claude Code
has **no** LSP tools — it only receives diagnostics after edits — so eleven of
those were beyond parity, and their schemas would crowd the prompt.

`extensions/lsp/` is now our own, ~600 lines with **zero dependencies**:
`protocol.ts` (Content-Length framing), `servers.ts` (language/server/root
detection, table taken from pi-lsp-extension), `client.ts` (spawn, initialize,
document sync, diagnostics), `format.ts` (rendering), `index.ts` (wiring).
Two behaviors only: error diagnostics appended to `edit`/`write` results, and a
deferred `lsp_diagnostics` tool. Adding hover or definition later is one
`client.request(...)` each.

Each fragility above is addressed by design:

- **No dependencies**, so no transitive protocol conflicts to pin.
- Child process and stdio handles are `unref`'d and shut down on
  `session_shutdown`, so one-shot runs exit — **the argv gate is gone and
  diagnostics now work in `-p` too**.
- Content is pushed with `didOpen`/`didChange` before every read, so an edit as
  the session's first action is covered, and answers reflect current content
  rather than whatever the server happened to cache.
- `getDiagnostics` awaits the server's next publish for that document (timeout
  plus last-known fallback) instead of sleeping a fixed interval.
- A TypeScript preflight detects the missing `tsserver.js` and returns a
  sentence explaining it, rather than degrading silently.

Diagnostics are still delivered in the tool result rather than through our
system-reminder queue: that is where the model needs them, and it costs one
delivery instead of two.

Verified end-to-end in one-shot mode: an edit introducing a type error appended
`src/index.ts:5:30 error: Argument of type 'number' is not assignable to
parameter of type 'string'. (2345) [typescript]` — matching `tsc` — the run
exited in 16s, no language-server processes leaked, the deferred tool loaded and
answered on demand, and a TypeScript 7 project returned the preflight
explanation.

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

## MCP — our own client on the official SDK

pi ships no MCP support by design, so this is `extensions/mcp/` (~500 lines) on
top of `@modelcontextprotocol/sdk`. That split is the point: the SDK carries the
protocol (a genuine standard, worth depending on), and we own the thin part —
config discovery, namespacing, lifecycle, deferral.

Both community options were rejected on the checklist:

- **`pi-mcp-extension`** still peers on the pre-rename `@mariozechner/pi-*`
  packages, i.e. it has not been touched since pi moved to Earendil.
- **`pi-mcp-adapter`** is 19,284 lines with twelve dependencies including a
  native keyring binding, a browser launcher, and a TOML parser — the same
  surface-far-past-the-need profile as the packages already removed.

Design notes:

- **Config is Claude Code's format**, merged lowest-to-highest from
  `~/.claude.json`, then `.mcp.json` walked from cwd up to the repo root
  (so a monorepo root config applies in subdirectories), then
  `.claude/settings.local.json`. `$VAR`/`${VAR}` are expanded in commands, args,
  env, urls and headers. Both stdio (`command`) and remote (`url`) servers work;
  a `disabled: true` entry *removes* a server inherited from a broader scope.
- **Tools are namespaced `mcp__<server>__<tool>`**, sanitised to legal tool-name
  characters, so users' existing Claude Code permission rules match. Verified:
  a `deny: ["mcp__fixture__add_numbers"]` rule blocked the call.
- **Every MCP tool is deferred.** A few servers can contribute dozens of tools;
  putting those schemas in the prompt is what `tool_search` exists to prevent.
- **JSON Schema is converted to TypeBox explicitly** (`schema.ts`) rather than
  passing raw schemas through and hoping TypeBox's runtime checks accept them.
  Unrecognised constructs degrade to permissive types, so an unusual server
  schema means arguments pass through rather than every call being rejected.
- Servers connect once at `session_start` (their tool lists are needed before
  anything can be registered), in parallel, each with a timeout, and close on
  `session_shutdown`. A failing server is reported by name and does not affect
  the others.

One bug worth remembering, caught only by the end-to-end test: `resources/read`
returns resource *contents* (`{uri, mimeType, text|blob}`) — **not** the typed
content blocks that `tools/call` returns. Running them through the content-block
formatter yielded `[undefined content]`. They now have their own formatter, which
also summarises binary blobs instead of dumping base64 into the context.

Verified against a fixture stdio server: `.mcp.json` discovered, tool loaded via
`tool_search` and called (`mcp__fixture__add_numbers` → `SUM_IS_42`), resources
listed and read, the deny rule enforced, and the run exited in 16s with no
lingering processes.

## Subagents: what matches Claude Code and what does not

`extensions/subagents/` is our own (see the rejection of `pi-subagents` above).
Agent definitions use Claude Code's markdown-plus-frontmatter format (`name`,
`description`, `tools`, `model`), discovered lowest-to-highest precedence from
the catalog bundled in this package (`agents/`), then `~/.claude/agents`, then
`<project>/.claude/agents` — so an existing Claude Code agent file overrides a
bundled one of the same name.

**Bundled catalog.** Three definitions mirroring Claude Code's built-ins:
`general-purpose` (full tool set), `explore` (read-only fan-out search),
and `plan` (read-only architect). Claude Code's other built-ins are
Anthropic-product specific (`claude-code-guide`, `statusline-setup`) and are not
reproduced.

**Implemented, verified live:**

- Parallel runs, four concurrent.
- Per-call `model` and `thinking` overrides (the agent file's frontmatter is the
  default). Verified a child running as `gpt-5.4` while the session ran 5.5.
- **`agent: "fork"`** — a child that inherits the caller's full conversation.
  This is a flag, not an implementation: pi's `--fork <session file>` clones a
  session, and `ctx.sessionManager.getSessionFile()` gives us the path. Verified
  by planting a codeword in the parent transcript and having the forked child
  recite it. Requires a persisted session; `--no-session` returns a clear error.
- **`isolation: "worktree"`** — `git worktree add` at HEAD on a throwaway branch,
  the child runs with that as cwd, and the worktree is removed afterwards *only
  if the agent changed nothing*; otherwise it is kept and its path reported so
  the work can be reviewed or merged. Verified: an agent's edit landed in the
  worktree, the main tree stayed clean, the dirty worktree survived, and a
  read-only run's worktree was cleaned up.

**Not implemented:** background/detached runs, and therefore no `TaskOutput` or
`TaskStop` equivalents; no `SendMessage` to resume a live agent. That is the
remaining Phase 8 work and it is genuinely more than a flag — it needs a run
registry, output spooling, and completion delivery (pi's `sendMessage` with
`deliverAs: "followUp"` is the likely mechanism). Also absent: `isolation:
"remote"`, which has no local equivalent.

## Permission modes and subagents

Permission mode lives in the permissions extension and is exported to child
processes via `CC_PERMISSION_MODE`; a child (marked by `PI_SUBAGENT_CHILD=1`)
inherits it unless a flag overrides. Plan mode is enforced twice on purpose —
the `tool_call` gate blocks mutations, and an every-turn `<system-reminder>`
tells the model not to attempt them.
