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
tool successfully.

Verified on Anthropic (2026-08-05, API key): both pi-owned paths, with
request-payload capture. Native (`claude-sonnet-5`, and any
`supportsToolReferences` model — first-party opus/sonnet/fable ≥5.4-ish, never
haiku): before activation the deactivated tools are simply absent from
`tools`; after `tool_search` activates `web_fetch`, the next request carries it
in `tools` with `defer_loading: true`. Fallback (`claude-haiku-4-5`): the
activated tool is appended as a full definition, complete `input_schema`, no
`defer_loading` flag. Both runs completed normally.

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

## Harness discipline (divergences found by self-comparison)

Comparing our implementation against the real Claude Code harness *as observed
from inside a session* surfaced behaviours that reading a request payload would
never reveal, because they are enforcement, not prompting.

**File freshness — `extensions/file-tracker/`.** Claude Code refuses to edit a
file the model has not read, refuses to write over an unread existing file,
rejects an edit when the file changed after the read, and reports out-of-band
changes with a line-numbered excerpt. This exists to prevent lost updates, and it
is why Claude Code can tell the model "do not re-read a file you just edited — the
harness tracks file state for you". We now do the same.

Tracking is **by content, not by tool call**, which is the load-bearing detail:
it catches writes made through bash that no tool hook can see. (In the session
that prompted this, the reminders I received were triggered by my own `python3`
edits.)

One conflict worth recording, because the first implementation had it backwards:
announcing an external change must **not** mark the file as read. If the pre-turn
scan records the new content, the file becomes "fresh" and the stale-edit guard
stops firing — so the harness would helpfully report the change and then permit
the clobbering edit. Notifications are tracked separately from reads, purely to
suppress repeat warnings.

**Denial feedback carries the user's words.** The prompt option says "No, tell the
agent what to do differently", so it now actually asks, and the typed reason is
appended to the block reason (`The user said: …`). Previously the option promised
something the code did not deliver.

**State-driven nudges.** Claude Code injects a reminder when the task tools have
gone unused. `todo_write` now does the same after eight quiet turns, and also
flags a list with no `in_progress` item or several of them. A todo tool nobody
remembers to call is decoration.

**CLAUDE.md framing.** Context files are now introduced with Claude Code's own
wording — "IMPORTANT: These instructions OVERRIDE any default behavior and you
MUST follow them exactly as written" — rather than a neutral "project-specific
instructions" header. Placement still differs deliberately: ours sits in the
system prompt (via pi), Claude Code's arrives in a first-user-message reminder.
Ours caches better.

**`context_management` — on by default for first-party Anthropic only.**
Claude Code sends `clear_thinking_20251015` on every request so long sessions
stop carrying old reasoning blocks. `extensions/context-management/` does this
via `before_provider_request`. Default: enabled when the model's provider is
`anthropic` on `api.anthropic.com` (verified there, and it is what Claude Code
does); disabled for every other `anthropic-messages` endpoint.
`CC_CLEAR_THINKING=0` forces it off; `=1` forces it on for an endpoint you
have confirmed accepts it.

**Enabling for other providers later** — the default is scoped narrowly only
because these are untested, not because they can't work. What each needs
before flipping it on:

- **Bedrock**: takes beta flags as `anthropic_beta` (array) *in the request
  body*, not the `anthropic-beta` header — needs its own request shaping plus
  a live check that it accepts `context_management` at all.
- **Vertex**: `anthropic_version` in the body; same question about
  `context_management` support.
- **Proxies/gateways (LiteLLM etc.)**: pass-through varies per deployment;
  users can already opt in per-endpoint with `CC_CLEAR_THINKING=1` once they
  have confirmed theirs forwards the header and body param.

To extend: broaden `clearThinkingEnabled()` per provider and add the
endpoint's beta representation next to `anthropicBetas()`; verify with a live
run using `debug-capture.ts` (remember it logs pre-mutation payloads — confirm
via absence of the 400, not via the capture).

Verified against the live API (2026-08-05, API key) — the body param alone is
not enough, found via a curl A/B:

- It requires `anthropic-beta: context-management-2025-06-27`, else 400
  "context_management: Extra inputs are not permitted".
- The edit requires thinking enabled or an adaptive-thinking model, else 400
  "`clear_thinking_20251015` strategy requires `thinking` to be enabled or
  adaptive" — so the payload hook gates on `payload.thinking` /
  `compat.forceAdaptiveThinking`.
- **Header clobber hazard**: an extension's `before_provider_headers` value
  merges *after* pi's computed headers, replacing pi's own `anthropic-beta`
  (OAuth identity betas, interleaved thinking for non-adaptive models,
  fine-grained tool streaming). `anthropicBetas()` therefore rebuilds pi's
  list (pinned v0.83 logic) and appends ours; OAuth is detected from
  `~/.pi/agent/auth.json` entry `type`. Re-check on pi upgrades.

Confirmed working end-to-end on `claude-haiku-4-5` (non-adaptive, thinking
gated) and `claude-sonnet-5` (adaptive): no API errors, normal completions.

Verified end-to-end: an unread-file edit was blocked and the file left untouched;
after an external edit the stale guard blocked the edit and the change reminder
reached the model (both visible in the request payload); a declined write
delivered `The user said: Use append mode instead…`; and the todo nudge appeared
after ten quiet turns.

**Deliberately not copied:** OS sandboxing and the LLM safety classifier that
gates bash (pi's stance is to containerize, and a classifier needs a model call
per command); harness-level command shaping such as blocking foreground `sleep`;
background agents with task notifications (still Phase 8); and mid-conversation
`role: "system"` messages, which pi's message types cannot express — our
user-message reminders are the closest equivalent.

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

## Publish readiness (Phase 7)

`npm pack` produces a 69 kB / 47-file tarball: `extensions/`, `agents/`, `types/`,
README, LICENSE and `docs/decisions.md`. Every path in the `pi.extensions`
manifest is checked to be present in the tarball.

**A path install does not fetch dependencies.** Verified by installing the packed
copy from a directory: pi registered it, then every extension importing a
dependency failed to load (`Cannot find module '@modelcontextprotocol/sdk/...'`).
`pi install npm:<name>` is fine, because npm resolves the dependency tree — so
the README tells anyone installing from a checkout to run `npm install` first.

The published path was verified by simulating its layout: `npm install <tarball>`
into a scratch project (348 packages resolved), then `pi install
<scratch>/node_modules/pi-claude-code`. A fresh run listed all bundled and plugin
agents correctly.

**Portability**: `web_fetch` through `tool_search` was exercised on
`gpt-5.4`, `gpt-5.5` and `gpt-5.6-terra` — a pre-native-deferred-loading model,
a native one, and a newer family — all correct. Anthropic's `defer_loading` path
and the non-native fallback remain unexercised for lack of a credential.

**Declined:** the CC-style UI packages (`pi-cc-header`, `pi-cc-extensions`). They
are cosmetic and would add a dependency for appearance only, which fails our own
adopt-vs-build checklist.

## Branding without a fork

pi's startup banner ("pi v0.83.0 … Ask it how to use or extend Pi") is built from
its `piConfig`, which resolves from pi's own installed `package.json` — a
dependent package cannot change it, as recorded above. But `ctx.ui.setHeader()`
replaces the header component outright, which reaches the same result:
`extensions/branding/` renders the package name, version, key hints and current
model/mode instead, and sets the terminal title. `CC_NO_BANNER=1` restores pi's.

Implementation note: a pi-tui `Component` is just `render(width)` plus
`invalidate()`, so the header is an inline object literal — no dependency on
pi-tui needed. It only applies when `ctx.mode === "tui"`; print and rpc modes have
no chrome to replace.

Verified rendering with `test/e2e/tui-capture.sh`:

```
pi-claude-code v0.1.0  Claude Code on the pi harness
escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
model claude-sonnet-5 · mode default
```

This is the cosmetic half of what a fork would buy. The other half — the `.pi`
config directory name — stays as it is; see the integration-shapes section in
`pi-notes.md` for when that would justify forking.

## MCP servers with unset credentials

Found from a real run: the `github` plugin's config is
`Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"`, and with the variable
unset our expansion produced the literal `"Bearer "`. The server then failed with
"Authorization header is badly formatted" — a confusing protocol error for what is
really a missing token.

`missingEnvVars()` now reports variables a config references but that are not set
(across command, args, env, url and headers), and such servers are **skipped with
an explanatory message** rather than connected with an empty credential:
`MCP server "github" failed: not started — GITHUB_PERSONAL_ACCESS_TOKEN not set in
the environment`.

## Themes: authored, not adopted

The ecosystem has no Claude Code *theme*. What it has are Claude Code-flavoured UI
**extensions** (`pi-cc-extensions`, `pi-claude-code-tui`, `pi-cc-header`) — code,
with the dependency risk already declined in the Phase 7 notes.

A pi theme, by contrast, is a JSON file of 51 colour tokens: data, and squarely in
the "cheaper to own than to depend on" half of the checklist. So `themes/` ships
two of our own, `claude-code` and `claude-code-light`, declared through
`pi.themes` in the manifest. The palette is a warm clay accent (`#d97757` dark,
`#c05f38` light) over neutral surfaces — an approximation of Claude Code's
terminal look, not values extracted from it.

`test/unit/themes.test.ts` validates every bundled theme: all 51 required tokens
present, no unknown tokens beyond the two optional ones, every `vars` reference
resolvable, and colours well-formed. pi rejects an incomplete theme at load time
without saying which token is missing, so this catches typos before a user does.

Both were then verified with `test/e2e/tui-capture.sh`, which runs pi inside tmux
to get a real pty: the startup screen lists `[Themes] claude-code,
claude-code-light` (so `pi.themes` discovery works for an installed package), and
with the theme selected the clay accent appears as a 24-bit escape in the rendered
output.

## Memory: own file-based implementation

The original plan scoped memory out as "Anthropic-hosted", but the memory
system Claude Code actually runs on is machine-local plain files the model
manages itself with ordinary file tools: one fact per markdown file under
`~/.claude/projects/<slug>/memory/`, a `MEMORY.md` index, a `# Memory` system
prompt section describing the format, and the index injected into the first
turn. All of that is local, so we implement it (`extensions/lib/memory.ts` +
`extensions/memory/`) rather than depend on `pi-memory`, whose model differs
(its own tools and storage format) and would not read or write Claude Code's
existing memory directories.

Fidelity details confirmed against the official memory doc
(<https://code.claude.com/docs/en/memory>), `payload.json`, and a live Claude
Code context:

- **Slug is keyed by git root, not cwd** — all worktrees and subdirectories of
  a repo share one memory directory; outside a repo the cwd is used. We resolve
  with `findGitRoot` (now in `lib/git.ts`).
- **Only the first 200 lines or 25KB of MEMORY.md load**; `truncateIndex`
  mirrors that. Topic files are never startup-loaded — the model reads them on
  demand.
- **Placement**: Claude Code nests the index inside the first-turn claudeMd
  `<system-reminder>` ("Contents of … (user's auto-memory, persists across
  conversations):"). We reuse that exact framing but emit a standalone
  reminder, because our CLAUDE.md equivalent travels through pi's
  `contextFiles` into the system prompt instead of a first-turn reminder.
- **Write-time frontmatter stamping** (found by diffing a real session
  transcript's Write inputs against the files on disk): Claude Code enriches a
  memory file's `metadata:` at write time with `node_type: memory`,
  `originSessionId`, and a `modified` ISO timestamp — and never adds
  frontmatter to a file that has none, which keeps MEMORY.md unstamped. We
  stamp by mutating the `write` tool's input in `tool_call`, *before*
  execution, so the file lands stamped and file-tracker observes the same
  bytes that hit disk (stamping after its `tool_result` observation would make
  every memory write look externally modified).
- **Write-time index limit guard**: after a write/edit of MEMORY.md, Claude
  Code measures the loadable content against the 200-line/25KB limits —
  near-limit it reminds the model to shorten the index; over-limit the write
  succeeds but the result is an error telling the model to rewrite. Replicated
  via the reminder queue and pi's rewritable `tool_result`.

Not replicated: relevance-based mid-session recall of individual memory files.
Its selection mechanism is undocumented client internals (the frontmatter
`description` is "used to decide relevance during recall", and the UI shows
"Recalled N memories"), and no recalled-memory block appears in either
captured context we have — including a long live session working on this very
project with a relevant memory on file. There is nothing observable to copy;
the injected index is the entry point and the model follows links from there.

Split follows the house pattern: pure helpers (slug, paths, truncation,
prompt/reminder text) in `lib/memory.ts`; the `memory` extension does mkdir +
first-turn reminder over the queue; `system-prompt` re-derives the directory
for its section (no shared module state — jiti). Using Claude Code's exact
slug and layout means memories written by real Claude Code sessions are picked
up unchanged, and vice versa.

Verified live via tmux + `debug-capture.ts` (the sandboxed shell can't run pi
directly): the `# Memory` section lands just before `# Environment`, the
directory is created with the expected slug on session start (from a
subdirectory of a git repo it resolves to the repo root), and a planted
`MEMORY.md` arrives as a `<system-reminder>` on the first user message.
Stamping was verified end-to-end with a real model run through the permission
gate (allow rules, no bypass flag): the model wrote plain frontmatter and the
file landed with `node_type`/`originSessionId`/`modified` in Claude Code's
field order, while MEMORY.md stayed unstamped.

## Rebrand: pincer

Anthropic's branding guidelines (published on the Claude Agent SDK docs, seen
2026-08) prohibit "Claude Code" product names, Claude Code-mimicking ASCII
art/visual elements, and products that appear to be Claude Code. They formally
address SDK partners — which this project is not — but the substance is
ordinary trademark hygiene and applies to anything published.

What changed (2026-08-05): package `pi-claude-code` → **`pincer-agent`**
(brand "pincer" — contains *pi*, means *claw*; plain `pincer` is taken on npm
by an old static file server). Banner `NAME`, system-prompt identity ("You are
pincer"), MCP client name, and web_fetch User-Agent follow. The banner mascot
— previously a deliberate homage to Claude Code's — is redrawn as a pixel π,
which is ours outright. Themes renamed `claude-code`/`claude-code-light` →
`pincer`/`pincer-light` (users with `"theme": "claude-code"` in pi settings
must re-select). Event channels renamed `pi-claude-code:*` → `pincer:*` —
done now, pre-publish, because the channel names are a documented third-party
contract that would be painful to change later.

What deliberately stays: every *descriptive* reference — "the Claude Code
experience on the pi harness", "reads your Claude Code settings.json" — is
nominative use (truthfully naming the thing we are compatible with), which
trademark law and the guidelines themselves permit. The fidelity references in
`tools/` and `payload.json` are captured artifacts, not branding, and are
untouched.

## Startup listing: quietStartup + banner sections

pi's startup resource listing has no per-section switch, and its [Extensions]
section names all twenty of this package's internal modules — noise to an end
user of the packaged product. The only lever pi offers is `quietStartup: true`
(global setting), which hides the entire listing but leaves a `setHeader`
banner alone (verified in tmux). `resourceLoader` is not exposed to
extensions, so the useful sections cannot be read back; instead the banner
re-derives compact `context` / `skills` / `themes` lines (the blessed
re-derive pattern): context files via the git-root walk, skills from the
Claude Code dirs — `existsSync` on `<dir>/<name>/SKILL.md` rather than
`isDirectory()`, because skill directories can be symlinks — plus namespaced
plugin skills from `discoverPlugins` (which pi's own listing misses, since the
plugins extension exposes those only through the `skill` tool), and themes
from the package's own directory. The sections render only when
`quietStartupEnabled()` reads true from pi's settings, so pi's listing and
ours never both appear.

## Workflow tool (ultracode orchestration)

`docs/plan.md` originally scoped Claude Code's `Workflow` tool out as
"Anthropic-server-backed, no local equivalent". That was wrong on both counts:
the tool contract is fully knowable (script with a leading pure-literal
`export const meta`, `agent()`/`parallel()`/`pipeline()`/`phase()`/`log()`/
`args`/`budget` globals, background runs, `resumeFromRunId` journal replay),
and QuintinShaw's `pi-dynamic-workflows` (npm, MIT) proves every piece runs
fine on pi's public SDK. Adopting that package was considered and rejected —
its tool surface diverges from Claude Code (model tiers, a verify/judgePanel
quality stdlib, different parameter names) and it is a fifty-module dependency
we would not control. `extensions/workflow/` reimplements the Claude Code
contract natively in eleven modules, borrowing three proven mechanics from it:
the acorn meta-lift (parse once, literal-walk the meta object so no code runs
to extract it, splice the export out, wrap the rest in an async IIFE whose
completion value `vm.runInContext` returns — this is what makes top-level
`await` and bare `return` work), in-process subagents, and positional-index
journal replay.

Subagents are in-process `createAgentSession()` calls with
`SessionManager.inMemory()`, not `pi --mode json` children like the subagent
tool: a workflow can spawn hundreds of agents, and per-spawn process overhead
plus JSONL re-parsing is pure waste when the SDK hands back typed events and
`getSessionStats()`. One `ModelRuntime` and one `DefaultResourceLoader`
(`noExtensions: true`) are built per run and shared across every agent —
building the loader per agent re-runs every installed extension factory, and
`noExtensions` also structurally blocks recursive orchestration. The sharp
edge found during design: `noExtensions` drops pincer's permissions extension
inside subagents too, so every bash/edit would run ungated. The fix relies on
`DefaultResourceLoader` always loading explicitly passed `extensionFactories`
even under `noExtensions`: `permission-gate.ts` reattaches a fail-closed inline
gate reusing the pure permissions matcher (deny rules win; explicit allows
allow; edits auto-allow, matching Claude Code's acceptEdits-for-subagents; an
"ask" outcome becomes a deny, because no prompt UI exists inside an agent()
call).

`acorn` became the package's first parser dependency (runtime `dependencies`,
not dev — consumers jiti-load raw .ts, so devDependencies never install).
Zero-dep, ~hundreds of KB; TypeScript's own parser would have meant shipping
tens of MB. The vm context is a determinism guard for resume replay
(`Math.random`/`Date.now`/argless `new Date()` throw; a Proxy on the vm
realm's own `Date` intercepts `now` and zero-arg construction), NOT a security
sandbox — the injected `agent()` does real host work regardless. Background
runs are the default (tool returns a runId; the report arrives via
`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`) and are
deliberately killed on `session_shutdown` rather than handed off across
`/reload`: the journal under `<sessionDir>/workflows/<runId>/` makes an
aborted run cheap to resume with `resumeFromRunId`, which replays the longest
prefix of agent() calls whose positional index and sha256(prompt+behavioral
opts) still match. `parallel()` invokes all thunks synchronously before
awaiting precisely so those indexes are deterministic under concurrency.

Opt-in works the way Claude Code's does, which is a system-reminder and not
model intuition: `pi.on("input")` matches `\bultracode\b` and emits a
next-turn reminder on `pincer:system-reminder` ("The user included the keyword
… use the workflow tool"), while the tool description carries the standing
gate ("ONLY call when the user has explicitly opted in… a task that would
merely benefit from a workflow does not count"). The description itself is
ported from Claude Code's rather than summarised: its authoring guidance —
pipeline-by-default with the barrier smell test, the canonical
review→adversarially-verify pipeline, the quality-pattern catalogue, the
"scale to what the user asked for" sizing rule — is what actually makes a
model write good scripts, so trimming it would cost the feature more than the
tokens save.

`workflow` joins `subagent` in `AUTO_ALLOWED_TOOLS`. Found by running it: the
first live `-p` run was blocked outright ("permission required but this session
is non-interactive"), which would make the tool unusable headlessly. The note
already next to `subagent` states the reasoning — orchestration is safe to
*launch* because each spawned child enforces tool permissions itself — and it
applies here more strongly, since a workflow script cannot touch the
filesystem, network, or shell at all; only its agents can, and they run behind
the gate above. A second live finding: that gate must exempt
`structured_output`, the tool the runtime injects for schema'd calls. Without
the exemption it fell to the fail-closed branch, every `schema` agent call
returned null after burning its retries, and the run still reported success
with a null hole in the result.

Verified: 51 unit tests over the pure modules (meta lift/rejects, wrap
round-trip through a real vm, limiter cap, parallel/pipeline null semantics,
callIndex determinism under out-of-order completion, replay
prefix/gap/carry-forward, gate allow/deny/ask-as-deny/internal-tool against
fixture settings files) and `tsc --noEmit` clean, plus live runs against
claude-haiku-4-5. Harness level (tmux, `-e` on this package): the tool reaches
the provider payload and the arming reminder with it (confirmed in a
`CC_E2E_LOG` capture); a sync run streamed phase/agent progress through
`onUpdate` and returned `red+blue` from a two-agent `parallel()`; a background
run of a saved `.claude/workflows/greet.js` returned its runId immediately and
delivered `[workflow-result]` as a follow-up message; `/workflows` listed both
the finished run and the saved workflow; the banner showed a `workflows`
section. Runtime level: a three-call script (parallel fan-out plus a schema'd
synthesis) journaled all three calls, and re-running it with `resumeFromRunId`
replayed the whole prefix in 11ms with zero live calls and an identical
result. Gate integration: with `deny: ["Bash(touch:*)"]`, a subagent told to
run `touch pwned.txt` reported "Denied by permission rules (rule:
Bash(touch:*))", `echo done` succeeded, and no file was created.

## `/effort`, and ultracode as a standing mode

Claude Code exposes reasoning effort as a Faster→Smarter slider whose last stop,
past `max` and behind a divider, is `ultracode` — subtitled "xhigh + workflows".
The divider is the whole point: every other stop buys more thinking, while that
one also changes *how the model works*, arming multi-agent orchestration on every
turn instead of the single turn the keyword arms. pincer now has the same
command, and the same two-tier opt-in: the keyword in a message for one turn
(`extensions/workflow`), `/effort ultracode` for a standing mode that persists
until switched off.

The mode is implemented the way the permissions extension implements plan mode —
an `every-turn` reminder on `pincer:system-reminder` under a key, withdrawn with
`{remove: true}` when leaving — plus `ctx.ui.setStatus` for a `✦ ultracode`
footer indicator. Its standing text is deliberately stronger than the keyword's
one-turn nudge: orchestrate substantive work *by default* and verify
adversarially, with trivial and conversational turns carved out so the mode does
not spawn a fleet to rename a variable.

The slider itself is a hand-rolled `Component` passed to `ctx.ui.custom()`,
following branding's precedent of implementing pi-tui's interface inline. That is
not stylistic: `@earendil-works/pi-tui` is a regular dependency of
pi-coding-agent rather than a peer, so it is unhoisted and unresolvable from this
package — pi's own thinking picker is a vertical `SelectList`, which we cannot
import and which is the wrong shape anyway. The cost is decoding keys from raw
bytes (`handleInput` hands over terminal data, not key names) and owning the
layout, so the marker row, labels, and track are laid out against measured
column positions and collapse to a single line rather than wrapping when the pane
is too narrow.

One live finding shaped the design. `setThinkingLevel` **clamps to model
capability silently** — no throw, no warning, and `thinking_level_select` fires
after the fact without a veto — so asking for xhigh on haiku-4-5 quietly yields
`high`. Rather than report a level the model never accepted, the command sets,
reads back, and says so: "Effort: ultracode — high reasoning, workflows armed
every turn (this model caps reasoning at high)". That also fixed a subtler bug:
the shift+tab hygiene (drop the mode when the user cycles thinking away, so the
footer cannot lie) originally compared against xhigh, which on a clamping model
would have made ultracode cancel itself the moment anything re-announced the
clamped level. It compares against the level the mode actually settled on.

Verified: 19 unit tests over the pure slider (choice/level mapping, both arrow
encodings, clamped movement, marker alignment under the selected label, the
ultracode subtitle appearing only when selected, narrow-pane degradation) and a
live tmux TUI run — the slider opened preselected at the current level, arrow
keys moved the marker, `ultracode` revealed its subtitle, Enter applied it with
the clamp reported honestly, `✦ ultracode` appeared in the footer, and a
`CC_E2E_LOG` capture confirmed the standing reminder in **both** subsequent
turns' payloads rather than just the first.

### Aligning `/effort` with shift+tab

The first cut left two dials disagreeing: shift+tab cycled pi's seven thinking
levels and called it "thinking", while `/effort` showed Claude Code's five plus
ultracode and called it "effort". Same underlying number, two names, two sets.

Taking over the key is not available: `app.thinking.cycle` is on pi's
`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` list, so `registerShortcut` on
shift+tab is skipped with a warning rather than honoured, and no extension API
unbinds or retargets a reserved key (only the user's own keybindings config can).
Disabling it was therefore off the table too, which settles the direction:
conform to the key rather than compete with it. The slider now offers exactly the
stops shift+tab walks through — `off` through `max` — and adds `ultracode` past
the divider, and everything we write calls the dial "effort" (banner hint
included; pi's own footer still says what it says). The slider footer names
shift+tab as the shortcut for the plain stops, so the two read as one control
with two entry points rather than two competing settings.

Widening the track from six stops to eight is what exposed a latent bug: the
layout only checked whether the *track* fit the pane, so the longer hint line
overflowed at 80 columns. Width is now measured on the unstyled text of every row
(escape codes would inflate the count), and anything that does not fit collapses
to a clipped one-line stop list — verified by a test that walks every stop at
widths from 200 down to 10.
