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
"Recalled N memories"), and no recalled-memory block has been
observed in practice — including in a long live session working on this very
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
`tools/` and `payload.json` are technical reference data, not branding, and
are untouched.

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

### Permission-mode cycling on ctrl+q, not shift+tab, ctrl+m, or alt+m

Claude Code cycles permission modes with shift+tab; typing
`/permission-mode acceptEdits` for the same switch was friction worth removing.
The obvious key is taken: pi reserves shift+tab for `app.thinking.cycle` (see
"Aligning `/effort` with shift+tab" above), and freeing it would mean writing
`app.thinking.cycle: []` into the user's `~/.pi/agent/keybindings.json` — a
package silently editing user config to defeat a deliberate reservation. That
was prototyped and rejected in favour of keeping pi's default: shift+tab stays
the effort dial.

ctrl+m was considered next and is impossible at the protocol level: ctrl+m *is*
carriage return (0x0D) in terminal encoding, so outside kitty-protocol
terminals `matchesKey("\r", "ctrl+m")` is true and every Enter press would
cycle the mode. pi-tui's `rawCtrlChar` confirms there is no special-casing.
alt+m — Claude Code's own documented fallback binding, used on Windows when VT
input is unavailable — shipped briefly and was rejected for macOS ergonomics:
option+m types "µ" unless the terminal is configured to send option as Meta,
which is off by default everywhere and not a setting to ask users for.

That leaves the ctrl+letters, and pi plus the terminal claim nearly all of
them: a/b/e/f/k/u/w/y (editor), c/d/z (clear/exit/suspend), g/l/n/o/p/t/v/x
(pi app keys), r/s (session picker), and h/i/j/m are Backspace/Tab/LF/CR at
the byte level. **ctrl+q** is the one left standing — historically XON flow
control, but pi's raw-mode TUI disables IXON so it arrives everywhere,
macOS included, with no configuration.

The modes themselves follow Claude Code v2.1 (verified against
code.claude.com/docs/en/permission-modes.md): `default` is displayed as
"manual" and `manual` is accepted as an alias everywhere a mode is named; the
cycle is manual → acceptEdits → plan, with bypassPermissions joining only when
the session started with it; `dontAsk` (deny instead of prompting; never in
the cycle) is accepted via flag/settings; footer badges use Claude Code's
exact strings (`⏸ manual mode on`, `⏵⏵ accept edits on`, …) via
`ctx.ui.setStatus`. Claude Code's `auto` mode is deliberately not implemented:
it is gated on a server-side approval classifier we have no equivalent of, and
Claude Code itself drops it from the cycle when unavailable, so its absence is
faithful rather than a gap. `/permission-mode` is gone; mode-change reminders
are keyed so cycling through several modes announces only the one settled on.
Verified in a live tmux TUI: badge at startup, three-stop cycle, bypass
joining under `--dangerously-skip-permissions`, and `/permission` completing
to only `/permissions`.

### Auto mode: a deterministic pre-gate in front of an LLM classifier

Claude Code's auto mode replaces per-action prompts with a classifier that
blocks anything irreversible, destructive, or aimed outside your environment.
The earlier entry above recorded it as deliberately unimplemented — no
equivalent classifier existed here. This entry supersedes that: one exists now,
built from two pieces that fail in different directions.

**The inverted contract, which is the whole design.** The deterministic half is
ported from the MI Copilot shell sandbox (a hand-rolled POSIX tokenizer plus
name-based command/path lists). In that codebase it is the *only* gate in Edit
mode, so every tokenizer gap is an exploitable bypass — its security review
found 80 confirmed findings, and the systemic root causes are all variations of
"a list drifted" or "the parser did not see it". Porting it as-is would import
all of that.

So its contract is inverted here: **`shell-analysis.ts` may only ever conclude
"provably safe", never "unsafe".** It sits in front of the classifier, which
sits in front of a user prompt, so an unrecognised command, a parse failure, an
unresolvable path, or syntax it does not model escalates instead of passing. A
gap now costs one classifier call rather than being a bypass, which converts the
review's entire tokenizer-gap class from vulnerabilities into latency. The
`CLAUDE.md` rule "never add a deny path to shell-analysis.ts" exists to keep
that property from being eroded by a well-meaning later change.

Its second job turned out to matter as much as the fast path: it extracts
**deterministic evidence** — the real command behind any wrapper, resolved write
targets with containment already decided, credential paths, paths whose contents
execute later — and hands that to the classifier. Parsing shell is what an LLM
classifier is worst at, so giving it facts instead of a command string is the
actual synergy between the halves, not just an optimisation.

**Review findings fixed while porting**, all now covered by tests that name the
finding: N1 (`$'…'` ANSI-C quoting, which upstream left a spurious `$` on so
path checks never ran), N2 (bare `.`/`..`), N3 (brace expansion), N4 (unspaced
`<>&|` boundaries), N5 (transparent wrappers — `env rm -rf ~/Desktop` classified
as a harmless `env`), N6 (tar/rsync/zip), N7 (`find -ok`/`-fprintf`), N8 (script
interpreters), N9 (dangling-symlink leaf: `ln -s /outside x` then `echo > x`
resolved inside the project while bash wrote outside), N10 (`>|`), N11 (git
default-deny by subcommand instead of enumerating mutations, so `git rm`/`mv`/
`archive`/`config` no longer slip through), N12/F6 (`cd` tracked; every token
checked against the credential list, not just path-shaped ones), N13/F3/F10 (one
shared case-folded denylist module instead of three that drifted), N18 (messages
quote the original token, never an expanded value — upstream leaked a token
through a *block* message), N20 (`.git/hooks`, `.git/config`, `mvnw` flagged
even in-project), N23 (`/proc`, `/sys`), F1 (`git -c` escalates).

**Config faithfully follows Claude Code**: prose `environment`/`allow`/
`soft_deny`/`hard_deny` lists with `"$defaults"` splicing, `classifyAllShell`,
the four-tier precedence (hard_deny > soft_deny > allow > explicit intent), and
the pause after 3 consecutive or 20 total blocks. Two properties are load-bearing
rather than cosmetic: `autoMode` is read from user and managed settings only —
never the project's, or a checked-in file could grant itself allow rules and
disable the gate containing it — and only pi's `input` event feeds the intent
tier, so intent cannot be manufactured by a prompt injection in a file the agent
read. Broad execution allow rules (`Bash`, `Bash(*)`) are suspended in auto mode
for the same reason: one would be a standing bypass.

**The classifier is a one-shot `completeSimple`** via `@earendil-works/pi-ai/compat`
with credentials from `ctx.modelRegistry.getApiKeyAndHeaders` — no tools, no
session, no history beyond the user messages handed to it, so there is nothing
for it to be talked into doing. Every failure path (no model, no credentials,
timeout, provider error, unparseable reply) returns a *block*; a gate that
cannot reach its classifier has approved nothing.

**Two bugs the live runs caught, both invisible to unit tests.** First,
`reasoning: "minimal"` with `maxTokens: 512` derives a thinking budget under
Anthropic's 1024-token floor, so every classifier request 400d — and the gate
dutifully reported each one as a block. It failed closed, correctly, and was
also completely broken. Omitting `reasoning` disables thinking outright
(`streamSimple` checks `!options?.reasoning`), which is what a classifier wants
anyway. Second, containment compared a realpath'd write target against an
unresolved working directory; on macOS `/var/folders/…` is a symlink to
`/private/var/…`, so every in-project write read as an escape.

**Calibration was verified in both directions against a live model**, which is
the only way to tell an over-blocking gate from a working one: routine in-project
work (mkdir, write, append, `git add`, `git commit`) ran unprompted; `echo hello >
~/probe.txt` was blocked when the user had not named that path, and allowed when
they had; "back up the project somewhere outside it, pick a location" was blocked
with "user did not name the backup path". Reaching that took two fixes — a
soft_deny rule worded as "irreversible *deletion*" was being stretched to cover a
file *creation*, and the intent tier needed a worked example before the
classifier would actually apply it. An auto mode that blocks what the user
plainly asked for gets switched off, so that tier failing quietly is as much a
defect as a missed block.

### Auto-mode parity pass against the published Claude Code behaviour

After the first implementation, the auto-mode docs were read line by line against
what had been built. Two things converged independently and are worth recording as
confirmation rather than coincidence: Claude Code's decision order is the same four
steps (rules resolve → reads and working-directory edits auto-approve → everything
else classified → a block returns its reason to the model), and it also **strips tool
results from the classifier's view** "so hostile content in a file or web page cannot
manipulate it directly" — the same isolation reached here by feeding the intent tier
only from pi's `input` event.

Seven divergences were found and fixed:

1. **The pause total counter never reset.** Claude Code resets it when it is the
   counter that triggered the fallback; without that, resuming from a 20-block pause
   leaves `total` at the limit and the next single block re-pauses immediately, making
   the resume single-use. A separate `lifetime` count now backs the user-facing
   message, since the fallback counter is no longer a running total.
2. **`defaultMode: "auto"` was readable from project settings.** The `autoMode` rules
   block was already user/managed-only, but the mode itself came through
   `loadPermissionSettings`, which reads `.claude/settings.json` — so a checked-in file
   could put a session into the mode whose classifier is what contains it. `auto` is
   now honoured from user settings only; every other mode still works per-project.
3. **Broad-allow-rule suspension was too narrow.** It caught a bare tool and `*`, but
   not wildcarded interpreters or runners, so `Bash(python*)` survived as a standing
   bypass. The rule now turns on a cleaner observation: a pattern with no `*` is
   exact-match and therefore narrow however powerful the command is (`Bash(python)`
   only starts a REPL), so only wildcarded patterns can be broad — and among those,
   an interpreter/runner head with nothing constraining its arguments is. Delegation
   rules (`Task`, `Agent`, `Workflow`) drop outright: a subagent is a fresh agent loop,
   so pre-approving one pre-approves whatever it decides to do.
4. **CLAUDE.md never reached the classifier**, though `ClassifyRequest` had a field for
   it. Claude Code's classifier reads the same instruction files the agent does, so
   "never force push" steers both. Now loaded from cwd up to the git root plus the
   user's global file, capped. Because those files are checked in, the prompt states
   they may *tighten* what is allowed but never widen it — without that asymmetry a
   repository could ship its own authorisation.
5. **Stated boundaries did nothing.** User messages were only ever read as
   *authorisation*; in Claude Code they also impose limits ("don't push until I
   review" blocks a push the default rules allow, until the user lifts it). The prompt
   now says user messages cut both ways.
6. **Protected paths were missing entirely** — a mechanism, not a rule. Writes to
   `.git`, `.claude`, `.vscode`, `.husky`, `.mvn`, shell rc files, `.npmrc`,
   `pre-commit` config, and build wrappers are never auto-approved, and in auto mode
   route to the classifier *even when an allow rule matches*: the check runs before
   allow rules, so `Edit(.claude/**)` cannot pre-approve reconfiguring the agent's own
   permissions. Being inside the working directory is not what makes such a write
   safe, which is the whole point.
7. **Subagents had one of three checkpoints.** Per-action classification came free
   (children inherit the mode), but the spawn was *auto-allowed* — `subagent` sits in
   `AUTO_ALLOWED_TOOLS` — so a delegated task was never judged, and there was no
   review when the child returned. Delegation now classifies at spawn in auto mode,
   and children log their actions (names and short subjects, never output) for a
   return review that prepends a warning to the result rather than blocking it: the
   work has already happened, so the useful move is to make sure it is seen. The
   return check exists because it is the only one that sees the *sequence* — "read the
   deploy config, read a token, open a PR" passes step by step.

**One bug the live runs caught, of a kind worth naming.** The first protected-path run
blocked correctly but reported "`.claude/notes.md` is outside the working directory",
which is false — it is inside. The classifier had been handed a call with no
explanation of why it was being asked, so it manufactured a plausible rationale. A
wrong reason is not cosmetic: it is what the user reads in `/permissions` and what the
model is told to act on. Routing cause is now passed in as a fact
(`<why_you_are_being_asked>`), the same principle as handing over static-analysis
facts instead of a command string: tell the classifier what is known rather than
letting it infer. On the re-run it allowed the write, correctly, on the explicit path
the user had named.

Verified live for each: an `Edit(.claude/**)` rule failing to pre-approve a `.claude`
write, a `Bash(python*)` rule failing to pre-approve a python one-liner writing
outside the working directory, and the same write allowed once the user named the path.

### Grounding the classifier's verdict: cite a rule, don't narrate one

The protected-path bug above — a `.claude/notes.md` write blocked "because it is
outside the working directory", which was false — was a symptom of a class, not a
one-off. The `reason` field was unconstrained generated text, and three consumers
treated it as authoritative: the user reading `/permissions`, the model being told
what to do instead, and **the gate itself**, which skipped the user's prompt
whenever `tier === "hard_deny"`. A fabricated tier did not merely misinform; it
removed the chance to approve something that was only a soft denial.

Claude Code hit this and retreated: from v2.1.208 its denial reason is the fixed
string `Blocked by classifier`, "the classifier scores each action on an internal
severity scale rather than writing an explanation" — having shipped written
explanations in v2.1.193 and moved off them. Suppressing the reason is not the
right trade here, since the reason is how a user knows which rule or environment
entry to change, so the answer is to keep it and make it unable to assert things
that are not so.

Three changes, in `auto-mode/rules.ts` and `prompt.ts`:

1. **`routedBecause` is required.** It was optional, and the routes that left it
   empty are exactly where confabulation happened: a classifier told nothing about
   why it is being asked will supply its own answer. The type now forces every
   call site to say why, with an explicit "nothing unusual, this is the residual
   path" default for ordinary calls.
2. **Rules are numbered and the verdict cites an id.** `H1`/`S4`/`A2` are rendered
   into the prompt; a block must cite one, or one of three reserved grounds that
   are real but are not numbered rules (`boundary`, `instructions`, `unclear`) —
   without those the classifier would have to force such a decision onto whichever
   rule looked closest, which is the misattribution being fixed. The id is
   validated against the index, **the tier is derived from the id's prefix** rather
   than from a field the model chose, and the user-visible reason is the cited
   rule's own text. A block citing an id that does not exist, or citing an allow
   rule as grounds for a denial, is still a block — but reported as exactly that,
   with tier `unmatched`, so it cannot borrow a real rule's authority to skip the
   prompt. The model's wording survives in `raw`, shown attributed to it.
3. **Raw verdicts are recorded**, on the denial and behind `CC_AUTO_MODE_DEBUG=1`
   on stderr, so this class is diagnosable rather than anecdotal.

**The citation requirement caused a permissiveness regression, which is worth
recording because it was not obvious.** Requiring a cited rule raised the bar for
*blocking* while leaving `allow` unconstrained, so uncertainty began draining
toward allow: "back up this project somewhere outside it, pick the location
yourself" — which had reliably blocked — started succeeding. The debug log showed
why, and it was only visible *because* of change 3: the classifier had correctly
identified the governing rule and then cleared it on intent, reasoning that the
user "explicitly requested" the backup. But that rule clears only when the user
*names the destination*, and "pick the location yourself" is the opposite of
naming one.

So a clearing condition that depends on the user having named something is now
checkable rather than a judgement: the classifier must quote the user's words
verbatim in `intentQuote`, and the quote is verified against the actual `input`
messages (normalised for case and whitespace, not wording). An intent that cannot
be found in the user's own words is not an intent — it downgrades to a soft
denial, so an interactive user can still approve it. This is the one claim worth
checking mechanically: it is what a prompt injection most wants to manufacture,
and, as this regression showed, also what the model is most prone to stretch on
its own.

Verified live in both directions: "write hello into ~/pincer-named-probe.txt — I
want that exact path" → `allow (intent)` with a verified quote, file created; the
delegated-destination backup → `block (S5)`, reported with S5's own text.

### Choosing the classifier model without leaking the session to another provider

The first cut searched the whole registry for a model whose id contained
`haiku`/`sonnet`/`flash`/`mini`/`small`. Checked against the real catalog (1153
models, 22 available on this machine), that is wrong in three separate ways.

**It crossed providers, which is the serious one.** On a session running
`openai-codex/gpt-5.5-codex` with an Anthropic key also configured, it selected
`anthropic/claude-haiku-4-5` — verified, not theoretical. The classifier receives
the user's own messages, their CLAUDE.md, and the text of the command being
judged, so this shipped that content to a vendor the user had not chosen for the
session, through a component with no UI at all. The invariant now: **never leave
the session's provider unless `autoMode.classifierModel` says to**, because naming
a provider is choosing it.

**Name matching does not survive real catalogs.** Of Groq's 7 models and xAI's 3,
*none* contain any of those substrings, so those providers fell through to the
session model. OpenRouter has 303 models and 79 substring hits, so "first match"
was arbitrary. On OpenAI it picked whichever `*mini*` came first in registry order
rather than `gpt-5-nano` at a fifth the price.

**Cost is the portable signal, but not naively.** Sorting cheapest-first puts
`openrouter/auto` first at `-1000000` — a sentinel, not a price — and Google's
free-tier entries at `$0`. Non-positive costs are therefore treated as *unpriced*
rather than cheap. A per-provider default table covers the catalogs where price
alone still picks badly, which is what makes OpenRouter tractable.

The resolution order follows the shape pi's own subagent config uses
(`subagents.defaultModel`, `agentOverrides.<name>.model`, `fallbackModels`,
session default), and for the same stated reason — pi's docs justify defaulting
to the session model as keeping "new installs from depending on a provider you
may not have configured", which is exactly the failure above:

1. `autoMode.classifierModel`, any provider.
2. A known-good cheap model for the session's provider.
3. The cheapest genuinely-priced model in that provider, no dearer than the
   session model — there is no point paying more to screen a call than to make it.
4. The session's own model: always correct, just not cheap.

More than one candidate is returned on purpose, mirroring `fallbackModels`: a
model that is unusable *on this account* (401/403/404, quota, not entitled) is
stepped over and recorded, so it is not retried on every call. A **transient**
failure is deliberately not stepped over — switching models there would paper over
something about to clear — so it surfaces as a block and the same model is tried
again next call. The choice is pinned on first success, so a registry refresh
cannot swap classifiers mid-session; Claude Code pins the same way.

Two things are now visible that were not. The footer names the model beside
`auto mode on` (`⏵⏵ auto mode on · haiku-4-5`), and it says nothing until the
first call settles which model that is, rather than guessing. `/auto-mode config`
shows the pinned model, the full candidate chain with the reason for each, and
anything found unusable. A `classifierModel` naming something unavailable used to
fall through in silence, leaving the user believing their setting was in force;
it now warns, names the setting, and says what is being used instead.

Verified live: badge empty before the first call and `· haiku-4-5` after, the
notice naming `anthropic/claude-haiku-4-5 (default for this provider)`, and a
deliberately bogus `classifierModel` producing the warning plus a working
fallback rather than a broken gate.

**Still open:** there is no capability floor. Claude Code gates auto mode's
availability on model tier because a weak classifier is a weak boundary; pincer
gates only on "a model exists", so a small local model can end up as the gate.
Refusing auto mode there would remove the feature exactly where self-hosted users
want it, so a warning on entry is the likelier answer.

### Three defects the real OpenRouter catalog exposed

Asking "so which model does OpenRouter actually use?" and running the selector
against pi's real 303-model OpenRouter catalog — rather than re-reading the table
— found three faults in the code committed an hour earlier. The answer itself was
right (`anthropic/claude-haiku-4.5`, which does exist there exactly), but:

**The provider-default branch ignored the budget ceiling.** A session on
`z-ai/glm-4.6` ($0.50/M) was screened by `anthropic/claude-haiku-4.5` ($1/M) —
twice the price of the work being screened, directly against this file's own
stated rule. The ceiling had only ever been applied to the cost-ranked branch.
Table entries are now tried in order against it, so a dearer default falls through
to the next entry: that session now gets `openai/gpt-5-mini` ($0.25).

**`:batch` and friends were selectable.** OpenRouter lists
`anthropic/claude-haiku-4.5:batch` at half price, `openai/gpt-5-nano:batch` at
$0.025. Batch endpoints are asynchronous, so a blocking gate would wait out its
timeout and then block the call — and because they are systematically cheaper,
cost ranking actively *prefers* them. Worse, `startsWith` matching meant a
`:batch` id could satisfy a plain table prefix. `:batch`, `:free` (rate-limited
hard enough that the gate fails intermittently), `:online` and `:thinking` are
excluded from automatic selection; an explicit `classifierModel` still wins,
since naming a model is choosing it.

**A model picked purely on price was leading the chain.** The cheapest OpenRouter
model is `inclusionai/ling-2.6-flash` at $0.01, and it ranked *above* the session
model — so had the default been unavailable, the security boundary would silently
have become an obscure model whose only qualification was being cheap.

The first attempt at that third fix is worth recording because it failed on the
same example. The idea was to let a cost-ranked pick lead only when its *name*
also placed it in a known small-model family, on the theory that two weak signals
agreeing beat either alone. `ling-2.6-flash` contains "flash", so it passed. The
word means "someone called this small", not "this family is known good", and any
vendor can put it in a name. The heuristic was deleted rather than patched:
**nothing chosen on price alone leads.** Vetted providers get their saving from
the table (which covers OpenRouter and every mainstream provider); anywhere else
the model the user already trusted for the real work screens the calls — correct,
merely not cheap — and the cost-ranked pick stays last, for when even that cannot
serve.

The general lesson is the one that keeps recurring in this feature: a table of
model ids and prices reads as fine and behaves differently against a real
catalog spanning three orders of magnitude in price. Verify selection logic by
running it over the actual registry, not by inspecting the table.

### Prompt caching, input size, and vendor containment on gateways

Three requests at once, and they turned out to interact.

**Gateway vendor containment.** The provider constraint was enforced at the wrong
granularity. On OpenRouter, a session on `openai/gpt-5.1` was being screened by
`anthropic/claude-haiku-4.5`: same pi provider, same API key — and the user's
messages and CLAUDE.md going to Anthropic, a vendor they had not picked. The pi
provider is the *gateway*; the vendor that actually receives the request is the
prefix in the model id. Candidacy on a gateway (`openrouter`,
`vercel-ai-gateway`, `cloudflare-ai-gateway`) is now narrowed to the session
model's own vendor, so `openai/gpt-5.1` gets `openai/gpt-5-mini` and a `z-ai/`
session with no cheaper `z-ai/` model is screened by the session model rather
than by another vendor. Groq, Bedrock and Copilot carry vendor-ish prefixes but
host those weights themselves, so they are deliberately not split.

The tables are keyed by vendor now, and flagship models were removed from them:
an entry matching the session's own model makes the table "choose" the very model
it exists to find something cheaper than. They also stop at the mini/haiku/flash
tier rather than nano/flash-lite — Claude Code runs its classifier on a
Sonnet-class model, and dropping to the bottom tier to save a fraction of a cent
trades away the judgement the gate exists for. `classifierModel` is there for
anyone who wants that trade.

**Caching: requested, and silently refused.** pi already puts an Anthropic
`cache_control` breakpoint on the system prompt, which a payload dump confirmed
(`cache_control: {type: "ephemeral"}` on a 9,777-character block). It never took
effect because the cacheable prefix was too short: the rules lived in the *user*
message, leaving ~1,270 tokens of instructions in the system prompt. Moving the
rule lists into the system prompt — they are instructions, not per-call data —
brings the stable prefix to ~2,570 tokens and makes it byte-identical across
calls in a session, which is a test now.

That is still not enough. **Claude Haiku 4.5's minimum cacheable prompt is 4,096
tokens** (2,048 is Haiku *3.5*), and Anthropic's documented behaviour is that a
shorter prompt "will be processed without caching, and no error is returned" —
exactly the silent no-op measured. So on Haiku, caching would require *growing*
the prompt ~60%, which is the opposite of the other request. It is left requested
(`cacheRetention: "long"`, harmless where unavailable) because the same prefix
does clear the 1,024-token floor on Sonnet-class models, where it will engage for
anyone who sets `classifierModel` accordingly.

`projectInstructions` deliberately stays out of the system prompt despite being
equally stable: CLAUDE.md is checked-in content this gate does not trust, and
promoting untrusted text into the system role to gain cache tokens would launder
its authority. Prefix caching does not care what follows the system block.

**Input size.** Instructions were compressed without dropping a rule or a worked
example (the intent examples are load-bearing — removing them regressed
calibration once already), and the nine `environment` entries that only said
"none configured" collapse to one line saying the same thing. Measured: input
3,233 → 2,934 tokens (-9%), output ~220 → ~140 (-36%, the tighter schema
description shortens `analysis`), cost $0.0043 → $0.0035 per classification
(-19%). Calibration re-verified in both directions afterwards: a named path still
clears on intent, an unnamed backup destination still blocks citing S5.

**A latent bug the caching experiment exposed.** Testing a Sonnet-class
classifier produced `400 temperature is deprecated for this model`. The classifier
was passing `temperature: 0` — which looks free, since a classifier wants
determinism — but it is deprecated on Sonnet 5, unsupported on Opus 4.7+, and
rejected by several OpenAI reasoning models, while pi's compat data still
advertises support. Any user whose classifier resolved to such a model would have
had **every tool call blocked**, and it was invisible because Haiku accepts it.
`temperature` is no longer sent. This is the third time in this feature that an
option which reads as harmless failed closed on a provider we were not testing
(thinking budget, macOS symlink containment, now temperature): a gate spanning 38
providers should send the minimum set of options it actually needs.

## Auto mode hardening: the pi-automode review, and what came of it

A review of [czottmann/pi-automode](https://github.com/czottmann/pi-automode)
(cloned at cff6d42, 2026-08-03) — an independent auto-mode implementation for
pi — against this one produced four adoptions, three rejections, and exposed
three real bugs in our own classifier fallback path. Per the community-work
convention, the outcome is recorded here.

**Adopted: an interactive classifier picker (`/auto-mode model`).** Their
strongest idea. Our automatic selection took three commits of fault-fixing
against real catalogs, and when it picks badly the only recourse was hand-editing
settings.json with a model id the user has to guess. The picker (filter by
prefix/substring/subsequence, prices shown, auth validated via
`getApiKeyAndHeaders` *before* persisting — theirs validates too) writes
`autoMode.classifierModel` to **user scope only** and releases the session pin so
the choice takes effect on the next call. `/auto-mode model clear` removes it.
This changes the failure economics of selection heuristics: any future fault
degrades to "pick it yourself" instead of "auto mode is broken". The picker's
header says plainly that the model reads your prompts and CLAUDE.md, because
choosing another provider is exactly the privacy decision model-select.ts refuses
to make automatically.

**Adopted: a deterministic deny floor for safety-control writes**
(`auto-mode/safety-floor.ts`). Their `deterministicHardDeny` guards its own
config deterministically; ours relied on the classifier's H-rules, which are only
as strong as the model enforcing them — a weak or talked-around classifier could
approve the one write that disables every check after it. Now a write/edit/bash
redirect landing on `~/.claude/settings.json`, managed settings, `~/.claude.json`,
or any `.claude/settings(.local).json` never reaches the classifier: interactive
sessions always prompt, headless runs block. Two deliberate asymmetries: the
shell pre-gate may only say "safe" (a gap costs a classifier call), the floor may
only say "stop" (a gap falls through to the classifier) — neither list needs to
be complete to be sound. And the floor matches exact files, not directories:
`~/.claude` also holds memory and skills the agent writes routinely, and a floor
that fires on routine work teaches the user to approve blind. Unlike their
unconditional hard-deny (which cannot be overridden even by a user who wants the
edit — and hard-denies `rm -rf` under `/private/tmp` on macOS), ours prompts:
editing your own settings is legitimate, it just isn't the classifier's to allow.
Floor targets are symlink-resolved with `resolveForContainment`, so
`ln -s ~/.claude/settings.json innocent.json` does not slip past. Verified live:
a headless auto-mode session asked to write `~/.claude/settings.json` was blocked
without a classifier call, both on the `write` tool and the bash retry.

**Adopted: config diagnostics.** Their `validateSettingsFile` inspired the same
for `autoMode`: invalid JSON (previously swallowed — the user believes rules are
in force that were never loaded), unknown keys, mistyped fields, and a list that
omits `$defaults` (so it *replaces* the built-ins) all surface in
`/auto-mode config`, which now also re-reads disk. Loading stays lenient; only
the report is new.

**Adopted: a decision log** (`auto-mode/decision-log.ts`,
`autoMode.logDecisions: true`). Theirs logs ccusage-compatible usage; ours logs
what we actually needed twice already: one JSONL line per gate decision — layer
(pre-gate / classifier / floor / user-at-prompt / subagent review), outcome,
tier, rule id, the classifier's raw commentary, and which model decided — in
`auto-mode-decisions.jsonl` next to the session files. Both prior regressions
were caught by reading raw verdicts under `CC_AUTO_MODE_DEBUG`, which only helps
when set *before* the session; and allows are invisible in the UI by design, so
the log is the only complete record of the permissive direction. Failures are
swallowed: a gate that blocks calls because its diary is unwritable has its
priorities backwards.

**Rejected: their model selection** (configured model or session model, nothing
else). It is admirably simple and trivially private, but it is our chain's
degraded case: an Opus session would screen every call with Opus at ~3k input
tokens each. The tables stay; the picker is the pressure valve that makes further
selection cleverness unnecessary. **Rejected: the two-stage fast/detailed
classifier** (one-digit gate, then JSON review). It saves output tokens, but our
deterministic pre-gate already removes the classifier from the hot path for free,
single-digit contracts are fragile on reasoning models (they budget 512 tokens
just for hidden reasoning before the digit), and a one-token "0" is an ungrounded
allow. **Rejected (and worth reporting upstream): project-local autoMode
config.** Their `.pi/automode.local.json` gets full `autoMode` authority from the
repo directory; nothing stops a malicious repo from committing one with
`{"enabled": false}` or a replaced hard-deny list (omitting `$defaults` only
warns). Their shared `.pi/automode.json` is correctly restricted to
`permissions.*` — the local variant defeats the same containment their own doc
comment claims. Ours reads user + managed scope only, unchanged. Their read-only
fast path also lets the `read` tool fetch `~/.ssh/id_rsa` unclassified while
`cat ~/.ssh/id_rsa` is their canonical hard-deny example.

**Three bugs found in our fallback path while comparing.** (1) A pinned
classifier that died mid-session was never unpinned: `rejected` grew but
`pinned` stayed, so every later call retried the dead model and auto mode
blocked everything until restart. Rejection now releases the pin, and the chain
rides behind the pinned attempt so the *same call* steps onward. (2) The
"everything rejected" retry took `all.slice(-1)` — the cost-ranked pick, the one
candidate the chain is designed never to lead with — while the comment claimed it
retried the session model. It now does what the comment says. (3)
`isModelUnavailableError` matched bare "quota", so a per-minute rate-limit blip
("quota exceeded, retry in 60s") permanently rejected a healthy model; only
billing forms (`insufficient_quota`, "exceeded your current quota") count now —
misreading billing as transient merely retries noisily, misreading a blip as
permanent bricks the candidate, so uncertainty drains toward transient. All three
are covered by `auto-mode-classifier-fallback.test.ts`, which mocks
`completeSimple` — the first tests of the fallback *sequence* rather than single
verdicts.

**Also: mode and classifier in the banner.** The banner's `mode` line was
hardcoded to "default". It now renders live — `mode auto · classifier haiku-4-5
(planned)` before the first call pins, the pinned model after, `(paused)` when
paused — fed by a `pincer:permission-status` event from the permissions
extension (jiti isolates module state, so this goes over the bus). The
protected-path check also gained the floor's symlink resolution: `decide()` takes
an optional `resolvedSubject`, so writing `.git/hooks` through a symlinked
spelling is as protected as writing it directly.

**A pi-tui trap this exposed** (now also in pi-notes): pi-tui **crashes the whole
app** on a rendered line wider than the terminal ("Rendered line exceeds terminal
width"), but only validates a component whose output *changed*. The banner's
skills line had been over-wide at 160 columns since quietStartup sections landed
— harmless while the banner was static, fatal the moment the mode line made it
re-render (ctrl+q killed pi outright). `bannerLines` now truncates every line to
the render width with an ANSI-aware helper that never splits an escape sequence
and resets colour before the ellipsis. Any `ctx.ui.custom`/`setHeader` component
must do the same.

## Subagent model selection: resolved in the parent, advertised by reminder

The subagent tool had the same model-selection faults the classifier was just
cured of, with higher stakes: the `model` field (per-call, or `.claude/agents`
frontmatter) was passed as a raw string to the child's `pi --model`, whose fuzzy
matcher substring-matches across **every configured provider** — so
`model: "sonnet"`, which is what real agent files and `CLAUDE_CODE_SUBAGENT_MODEL`
say, resolved to an effectively arbitrary provider. A fork child inherits the
parent's whole transcript, so the silent crossing ships the entire conversation.
There was also no default knob (Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL` was
ignored, including from the settings `env` block) and no fallback (an
unavailable model just failed the run in the child, its warning invisible).

Resolution now happens in the parent (`subagents/model-select.ts`), against the
real registry, and the child is spawned with a concrete `provider/id`:

- **Aliases stay contained.** `sonnet|opus|haiku|fable` resolve by name within
  the session's provider (and upstream vendor on gateways), preferring undated
  ids; off-family ("sonnet" on Groq) the session model serves and the parent
  says so. `inherit` is the session model.
- **Exact references resolve anywhere, never silently.** Naming a model is
  choosing it — but a provider crossing is announced, because the user
  configuring a key for a provider is not the user choosing to send this
  conversation there.
- **Precedence:** per-call `model` > agent frontmatter > `subagentModel`
  setting > `CLAUDE_CODE_SUBAGENT_MODEL` (real env, then user/managed settings
  `env` block — project scope deliberately unread, same containment as
  `autoMode`) > session model. A bad *configured* value degrades to the session
  model with a notice naming the knob; only a bad *per-call* value errors,
  because the model that wrote it gets the menu and can retry.
- **Passing the session model explicitly is itself a fix**: a child spawned with
  no `--model` picks pi's saved default, not the parent's current model, so a
  mid-session ctrl+p switch silently desynced children before.

**The menu.** The main model needs to know what values are valid — Claude Code
solves this with a static enum, possible only because it is single-provider. A
tool-schema listing was rejected: the menu depends on the session model, which
changes mid-session, and a schema rebuild throws away the whole cached prefix. A
static schema line names the alias vocabulary; the catalog itself rides in a
**keyed every-turn reminder** (`subagent-models`), which survives compaction by
construction (reminders are transient per-request injections, never in the
session file) and is replaced on `model_select`, so the next LLM call — even
mid-turn — carries the update. Gateway catalogs (OpenRouter: 300+) are curated,
not dumped: vendor-contained, `:batch`/`:free`/unpriced filtered, dated
duplicates collapsed, capped at a handful of lines — safe because the menu is
advertising, not a whitelist; resolution accepts unlisted models, and the
reminder says so. The "nothing price-picked may lead" rule deliberately does
not apply here: a cheap classifier fails open, a cheap subagent just does
mediocre reviewed work, so price-ranked suggestions with prices shown are fine.

Workflow's `agent()` shares the resolver (it used pi's `resolveCliModel` —
same cross-provider fuzzy matching, in-process), keeping its `":high"` effort
suffix and surfacing notices as run-log events. The banner shows
`subagents <model>` when the resolved default differs from the session model
(when it doesn't, the model line already says it); the banner's own model line
also follows `model_select` now instead of freezing at startup.

Verified live: the banner shows `subagents sonnet-5` from this machine's
`CLAUDE_CODE_SUBAGENT_MODEL: "sonnet"` settings-env entry (previously ignored);
the reminder appears in the captured provider request with the resolved default
and prices; and a real `subagent` run spawned its child on
`anthropic/claude-sonnet-5`, resolved from the alias in the parent.

## Plan mode is file-based, like current Claude Code

Claude Code moved plan mode from "pass the plan as an ExitPlanMode parameter"
to a **plan file**: entering plan mode allocates `~/.pincer/plans/<slug>.md`,
a per-turn system message names it as the one writable path and prescribes an
explore→design→review→write→approve workflow, and ExitPlanMode takes no
parameters — it reads the file. Observed live in Claude Code and mirrored here: the plan
survives compaction, the user can open/edit it, and long plans stop bloating
tool calls and `ui.select` titles.

**Who owns what.** Mode stays with `permissions`; the file belongs to
`plan-mode`. Allocation happens in `before_agent_start` — the one hook that
covers all three entry points (tool, ctrl+q, `defaultMode: "plan"`) and runs
after every extension's `session_start`, so restoring the branch's previous
path (a `plan-mode-file` custom entry, read via `getBranch()` like tasks/todo)
can never race a fresh allocation. The path crosses to the matcher over a new
`pincer:plan-file-path` channel, mirroring `pincer:set-permission-mode` in the
other direction; `plan-mode` learns the mode from the existing
`pincer:permission-status` channel rather than a shared module (jiti).

**The reminder key moved.** `setMode` no longer emits plan mode's reminder;
`plan-mode` re-emits under the same `"permission-mode"` key every turn, with
`existsSync` flipping "create it at …" to "continue building …" the turn after
the file appears. Every-turn re-emits replace by key, so nothing accumulates.

**The carve-out allows outright.** In plan mode a write whose subject (or
symlink-resolved subject) is the plan file returns `allow`, and everything
else keeps denying. Outside plan mode the file has no special status, matching
Claude Code. Deny rules still beat the carve-out. (`.pincer` itself is a
protected dir like `.claude`; `.pincer/plans` is excepted as working space —
plan documents are rendered to the user, never executed.)

**Slug fidelity note.** Claude Code's real slugs start with the user's opening
words plus two random words (`we-are-going-to-async-turtle.md`); pincer uses
three random words. Deriving from the prompt was skipped — the slug is
allocated before any user text is guaranteed to exist (ctrl+q, defaultMode).

Verified live: an RPC run (no `--dangerously-skip-permissions`) showed a
blocked ordinary write and an unprompted plan-file write in plan mode; a tmux
TUI run exercised the scrollable approval viewer (scroll, choice switch,
reject→stay-planning, Enter→approve→manual mode) and ctrl+q entry reusing the
session's existing file.

## Own state, borrowed config: `.claude` is read-only, pincer writes to `~/.pincer`

pincer sat in a three-way namespace muddle: pi owns `~/.pi` (sessions,
models.json — harness plumbing, invisible, and untouchable without forking),
`.claude` is Claude Code's directory, and pincer had started *generating*
state into the latter (plan files at first; memory was already there at
`~/.claude/projects/<slug>/memory`). Reading `.claude` deeply is the product —
"your Claude Code setup works on any model" is the pitch, so settings, skills,
commands, agents, plugins, and CLAUDE.md stay read-from-`.claude` forever. But
*writing* into a namespace another product owns invites collisions: Claude
Code also writes under `~/.claude/projects/<slug>/` and evolves that layout
without notice, and a user auditing "what did Claude Code do" finds artifacts
it didn't make.

The policy, in one line: **`.claude` is a read-only compat surface; everything
pincer generates goes to `~/.pincer`.** `extensions/lib/paths.ts` centralises
both roots — `claudeConfigDir()` (honouring `CLAUDE_CONFIG_DIR`, which Claude
Code itself supports and pincer previously ignored) and `pincerStateDir()`
(honouring `PINCER_STATE_DIR`). Plan files moved to `~/.pincer/plans`
immediately, while the feature was a day old. `.pincer` joined the protected
dirs (the gate's own namespace must be as guarded in its new home as in the
old), with `.pincer/plans` excepted as working space. Deliberately *not* done:
a pincer-native settings schema (no demand yet — compat reads suffice), and
the memory-dir migration, which has a real tradeoff (sharing memory with
Claude Code on the same repo is arguably a feature) and waits on its own
decision.

## Hooks: own the mechanism, port the best of three references

Claude Code command hooks were the biggest remaining compat gap — real setups
carry `PreToolUse`/`PostToolUse`/`UserPromptSubmit` hooks in settings.json and
plugins ship `hooks/hooks.json`. Three MIT community implementations were
studied before building (`extensions/hooks/`); none survived as a dependency,
all three contributed:

- **`pi-code`** (ilovepixelart): the executor hardening — absolute `/bin/sh`,
  `detached: true` + SIGKILL to the negative pid so grandchildren holding the
  stdio pipes die with the timeout, utf8 stream decoding, 1MB output caps,
  `CLAUDE_PROJECT_DIR`, the Node timer-overflow clamp — plus reading real
  `.claude/settings.json` and the deliberate **ask→block** fail-closed mapping
  (pi's tool_call is allow-or-block; ask-as-allow is the unsafe reading).
- **`@hsingjui/pi-hooks`**: the CC JSON envelope parsing, hidden-custom-message
  context injection, and the Stop-hook loop re-trigger
  (`deliverAs: "followUp", triggerTurn: true` + a `stop_hook_active`
  re-entrancy flag). Not adopted as a dependency because it reads
  `.pi/settings.json` rather than `.claude`, and its bugs were ported *around*:
  snake_case event aliases, `if` conditions silently disabling non-tool hooks,
  compact trigger hardcoded to "manual".
- **`pi-fairy-tales`**: the mtime-keyed config reload (both others only reload
  at session_start).

Decisions that shaped the wiring:

- **Position in `pi.extensions` is the mechanism** for CC's "hook updatedInput
  applies before permission evaluation": hooks sits right after
  system-reminder, ahead of worktree (which rewrites `input.command` into a
  `cd … && (…)` block — matchers must see the model's original call),
  file-tracker, and permissions. pi passes the same `event.input` object to
  every handler, so an in-place mutation is exactly what the gate, safety
  floor, and classifier evaluate.
- **A hook can never pre-approve**: `permissionDecision: "allow"` is parsed and
  ignored. Deny direction is honoured everywhere; timeouts fail closed for
  PreToolUse/UserPromptSubmit only.
- **Trust**: project/local hooks are arbitrary code execution, so they run
  after a once-per-config consent (sha256 of the canonicalised project hook
  config, persisted in `~/.pincer/hooks/project-approvals.json`; a decline
  sticks for the session only). pi's own project-trust store was deliberately
  not reused — it never triggers for repos that have only `.claude/*` files.
  Plugin hooks are user scope: installing the plugin was the consent.
- **No loader exemption** (user decision): a hook may block `tool_search`/
  `skill`/`structured_output`, full CC fidelity — see the foot-gun note in
  pi-notes.
- **additionalContext** is a hidden `pi.sendMessage` custom message (persisted,
  survives resume), not a reminder-queue entry (transient) and not deferred to
  `before_agent_start` (fires once per outer turn — mid-loop context would
  arrive a turn late). Mid-loop events use `deliverAs: "steer"`; prompt-time
  context is stashed and injected at `before_agent_start` so it lands on the
  same turn as the prompt.
- **Notification is unsupported**: pi has no event carrying that concept;
  documented rather than stubbed. `http`/`prompt`/`agent` hook types are
  skipped with a diagnostic.

Verified live (rpc e2e, no --dangerously-skip-permissions): consent prompt
shown once; approved run executes the hook, blocks the bash call with the
hook's stderr as reason, and no permission prompt fires for it (the hook
short-circuits ahead of the gate); declined run never executes the hook and
the same call flows to the ordinary permission prompt.

## Shared role profiles: smaller classifiers and delegated workers by default

A real OpenAI Codex session exposed two different defaults with the same costly
result: selecting `gpt-5.6-sol` made the banner read `classifier 5.6-sol
(planned)` and `subagents 5.6-sol (session)`. The classifier's provider table
predated Luna and 5.4 Mini, so its deliberate "session before anything chosen
only by price" fallback did exactly what it should. Subagents had a separate,
intentional session-model default. Workflow `agent()` had a third path: it
always received `ctx.model`, so it did not actually honour `/subagent` despite
the command and reminder saying it did.

The fix is one pure policy layer (`extensions/lib/model-policy.ts`) shared by
both selectors, but **not one shared capability rule**:

- classifier profiles contain only reviewed small-but-capable families; price
  alone can never promote a model into the security boundary;
- subagent profiles prefer economical coding/reasoning models, then may use a
  cheaper price-ranked model when the provider policy says containment is
  knowable;
- explicit classifier, per-call, agent-frontmatter, and `/subagent` choices
  retain their old precedence and may cross providers because naming one is
  choosing it; `inherit` explicitly suppresses automatic selection;
- both roles finish at the session model rather than breaking the feature.

Automatic subagent selection is a *cost optimisation*, and review tightened it
to demand cost evidence: it engages only when both the session model and the
candidate carry real prices and the candidate is strictly cheaper. Without that
rule an unpriced catalog let the profile's order silently *upgrade* a haiku
session to sonnet-class. The price-ranked fallback (for when the profile has
gone stale) additionally requires one of the known small-model name words and
ranks those tiers ahead of raw price — otherwise the absolute cheapest
contained model became the default coding worker, which on a mainstream catalog
is nano/lite-tier or something wholly unknown. And once any *explicit* choice
(agent frontmatter or configured default) fails to resolve, automatic selection
stays out of it: substituting a cheaper vetted model for a model somebody named
is a model nobody described, so the remaining chain and then the session model
serve.

The profile inventory was checked on 2026-08-06 against pi 0.84.0's generated
catalog and official model pages: [Anthropic](https://platform.claude.com/docs/en/about-claude/models/overview),
[OpenAI](https://developers.openai.com/api/docs/models),
[Google](https://ai.google.dev/gemini-api/docs/models),
[xAI](https://docs.x.ai/developers/models),
[Mistral](https://docs.mistral.ai/getting-started/models/models_overview/),
[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing),
[Z.AI](https://docs.z.ai/), [Qwen Coding Plan](https://help.aliyun.com/en/model-studio/coding-plan),
[Kimi](https://platform.kimi.ai/docs/models),
[MiniMax](https://platform.minimax.io/docs/guides/models-intro),
[Xiaomi](https://mimo.mi.com/docs/quick-start/summary/model), and
[Ant Ling](https://developer.ant-ling.com/en/docs/models/ling/). Hosted-profile
IDs came from the official catalogs for [NVIDIA NIM](https://build.nvidia.com/models),
[Groq](https://console.groq.com/docs/models),
[Cerebras](https://inference-docs.cerebras.ai/models/overview),
[Fireworks](https://fireworks.ai/models),
[Together](https://docs.together.ai/docs/serverless/models),
[Baseten](https://www.baseten.co/products/model-apis/), and
[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/).
The lists are intentionally short prefixes applied to the *live authenticated
catalog*, not copied catalogs; unavailable entries simply fall through.

All 39 built-in pi language-model provider IDs have an explicit policy. Direct
vendors contain to the provider. Stable hosted inference services such as Groq
and NVIDIA contain to that host even when IDs carry publisher-like prefixes.
Gateways require more care:

- OpenRouter's `creator/model` prefix identifies a model namespace, **not the
  serving inference provider**; automatic switching stays in that namespace and
  reuses its direct-family profile, but pincer cannot claim processor
  containment because pi exposes none of OpenRouter's provider-routing options
  ([official routing semantics](https://openrouter.ai/docs/guides/routing/provider-selection)).
- Vercel likewise separates creator IDs from serving providers; profile reuse
  stays in the creator namespace ([provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)).
- Cloudflare's generated pi catalog strips some upstream prefixes, so route
  identity comes from API/base transport rather than slash parsing
  ([provider integrations](https://developers.cloudflare.com/ai-gateway/providers/)).
- Bedrock containment includes geography plus family: an automatic choice may
  not move from `us.` to `eu.` or `global.`. Opaque application-profile ARNs
  stay on the session model ([model IDs](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)).
- Hugging Face, Radius, OpenCode Zen, OpenCode Go, unknown aliases, and custom
  providers whose route cannot be established are session-only automatically.
  Hugging Face repository IDs in particular do not name the serving inference
  provider unless a provider suffix is pinned
  ([routing docs](https://huggingface.co/docs/inference-providers/en/index)).

With no explicit default, an OpenAI Codex Sol session now plans both its
classifier and delegated workers on Luna. The banner labels the latter `(auto)`
rather than implying it came from settings. `workflow/index.ts` passes the same
user/managed default into `AgentRunner`, and workflow calls no longer bypass
the automatic resolver when `model` is omitted.

Verified against fresh pi processes: the TUI banner showed `model 5.6-sol ·
subagents 5.6-luna (auto)`; an omitted-model foreground subagent recorded
`openai-codex/gpt-5.6-luna`; and an omitted-model synchronous workflow completed
on the same low-cost path. Luna's classifier was exercised in both directions
without `--dangerously-skip-permissions`: an exact user-named `/tmp` write was
allowed by verified intent, while a delegated outside-project backup path was
blocked under S5. Typecheck and all 682 unit tests passed.

## Upward cost pressure: an informational warning and a per-call gate

Automatic selection only ever moves cost *down*, but two paths still let a
subagent run on something pricier than the session model: a configured default
(deliberate cheap-driver/strong-worker setups exist) and the per-call `model`
field (chosen by the main model itself). Those get different treatment because
their authors differ:

- **Configured default pricier than the session model** → one informational
  line in the every-turn reminder, with both prices. It suggests a cheaper
  listed model for routine tasks but does not tell the model to override the
  user's knob — the user set it, and second-guessing a user setting from the
  reminder would invert authority.
- **Per-call `model` pricier than the session model** → the subagent tool
  errors with both prices and the menu, and workflow `agent()` throws, unless
  the call sets `allow_expensive: true` (`allowExpensive` in agent() opts). The
  schema tells the model to set it only when the user explicitly asked for that
  model. Only `source: "call"` resolutions are gated: `subagentModel`, the env
  var, agent-file frontmatter, and `inherit` are user-installed choices, and
  the codebase rule is that naming a model is choosing it.

The gate opens when either price is unknown — a cost gate that fails closed on
an unpriced catalog blocks the feature outright, the same failure shape as
gating a tool other tools sit behind.

## web_fetch answers a `prompt` with a reader model

The original deviation ("no clean in-process completion helper; a summariser
that fails silently degrades quality invisibly") went stale on both halves: the
auto-mode classifier has been making exactly this call via pi-ai's
`completeSimple` for months, and the silent-failure objection argues for a
*loud fallback*, not for omitting the feature. So `web_fetch` now takes Claude
Code's optional `prompt`, and a reader model answers it against up to 120k
chars of the page — four times the window the main model would get — returning
just the answer with a header naming the reader.

The reader reuses the **classifier role profile** rather than adding a third
curated inventory: summarisation wants the same small-but-capable floor, and
two lists drifting apart helps nobody. Same containment (the page and the
query go to the reader, so it never leaves the session's provider/family) and
the same cost ceiling (never pricier than the session model); with no vetted
smaller model the session model reads the page itself, which still wins by
keeping the full page out of the conversation. `reasoning` and `temperature`
are not sent, for the same fail-closed reasons recorded for the classifier.
Any reader failure returns the raw windowed markdown with a note naming the
error — the fetch is never wasted and the degradation is never silent. Page
content rides in the user message tagged as untrusted data, and the system
prompt pins the reader to extraction.

Verified live on an OpenAI Codex Sol session (one-shot `--mode json` run with
`--dangerously-skip-permissions`; the tool's permission surface is unchanged by
this feature): the reader resolved to `openai-codex/gpt-5.6-luna` via the
classifier profile, and the tool result read "Answered by
openai-codex/gpt-5.6-luna from the full page" with a correct answer for the
fetched page. Typecheck and all 698 unit tests pass.

## The memory dir is harness-designated working space, like the plan file

Auto mode blocked the auto-memory feature it ships next to: the system prompt
instructs the model to write memories into `~/.claude/projects/<slug>/memory`,
which is both outside the working directory and under the protected `.claude`
dir, so every memory write went to the classifier and its out-of-project rule
(correctly, per its own text) blocked it. The harness was flagging its own
instruction.

The fix follows the plan-file precedent exactly: `decide()` takes a
`memoryDirPath` and deterministically allows *writing-tool* calls that land
inside it, with cause `memory-dir`. Scope notes, since this punches through
the protected-path check:

- Deny rules and explicit ask rules still win — an ask rule is the user's
  stated intent to be prompted, and the check sits after both.
- Only the exact per-project dir clears. Another project's memory dir, and
  everything else under `.claude`, still hits the protected-path check.
- The check judges `resolvedSubject` when available — where the write actually
  *lands* — so a symlink planted inside the memory dir cannot convert the
  allow into a write elsewhere; `resolve()` normalises `..` traversals for the
  same reason. Bash writes into the dir are not cleared, only the write tools.
- The permissions extension re-derives the dir (`memoryDir` + `findGitRoot`)
  rather than sharing state with the memory extension, per the jiti
  module-isolation rule. The workflow permission gate does the same, since
  memory writes inside `agent()` calls previously died on "needs interactive
  approval".
- Plan mode still denies memory writes (unchanged); the auto-mode safety floor
  is unaffected — it deliberately targets exact settings files and already
  documents that `~/.claude` holds memory the agent writes routinely.
- Trap, caught live: `resolveForContainment` returns a *case-folded* path, so
  any prefix/equality check against it must case-fold both sides (as
  `isProtectedPath` does). The first cut compared case-sensitively, matched
  nothing on macOS, and every memory write silently fell through to the
  protected-path check — visible only because the live run was checked before
  committing.

## Session scratchpad, Claude Code-style

Claude Code gives every session a scratchpad
(`<tmp>/claude-<uid>/<project-slug>/<session-id>/scratchpad`) via a system
prompt section and lets it be used "generally without permission prompts";
pincer had nothing, so temp files landed in `/tmp` or the project — and in
auto mode, `/tmp` writes are exactly the out-of-project pattern the classifier
flags. Same failure family as the memory-dir block, fixed with the same
mechanism:

- `lib/scratchpad.ts` derives the path (pure core + `sessionScratchpadDir`
  re-derived by every consumer, per the jiti module-isolation rule) and
  carries the prompt section verbatim from `payload.json`. `/tmp` is resolved
  through its symlink up front so the prompt, the permission comparison, and
  the case-folded resolved subject all name one real location.
- The system-prompt extension mkdirs it at `session_start` and renders the
  section. The path embeds the session id, so it deliberately lives *outside*
  the (cwd, model)-cached environment block — constant within a session, which
  is all provider prompt caching needs. An unwritable tmp drops the section
  rather than promising a directory writes will error on.
- `decide()` grew a `scratchpadDirPath` beside `memoryDirPath` — one shared
  `isInsideDir` check (resolved subject, case-folded, traversal-safe), deny
  and ask rules still winning, other sessions' scratchpads and bare `/tmp`
  not cleared. The workflow gate derives the *child's* scratchpad lazily from
  its first tool call, since the child session id does not exist when the
  gate is constructed.
- The write tools get the deterministic allow; bash into the scratchpad still
  goes to the classifier, so the outside-cwd default rule now names the
  harness's designated directories (scratchpad, auto-memory) as clearing it.

Verified live without `--dangerously-skip-permissions`: a plain `-p` session
was asked for "a temporary file in the right place per your instructions",
wrote `notes.txt` into its own session scratchpad path, and the file was on
disk — no prompt, correct slug and session id. Typecheck and 711 unit tests
pass.

## Compaction runs Claude Code's prompt, via session_before_compact

pi hardcodes its own summarization prompt (settings only expose
enabled/reserveTokens/keepRecentTokens), but `session_before_compact` lets an
extension supply the whole `CompactionResult` — so pincer now compacts the
way Claude Code does. Three design points:

- **The prompt**: appended as user text after the conversation; the model
  answers `<analysis>` + `<summary>`, and only the `<summary>` content
  survives. `extractSummary` matches tags at *line starts* and spans to the
  last closing tag; an untagged reply is used whole minus any analysis block —
  losing a compaction to a formatting slip is worse than untidy text. Empty
  means failure. Trap, caught live: the first run's analysis said "wrapped in
  `<analysis>` and `<summary>` tags", a loose regex anchored on that inline
  mention, and the stored summary began with the tail of the analysis — prose
  *about* the format is indistinguishable from the format unless tags are
  line-anchored.
- **The model — the session model, for the cache**: Claude Code keeps the
  session's system prompt, tool definitions, and message prefix intact,
  appends the instruction, and runs the call on the session's own model. That
  is not thrift on the model choice — it is thrift on the *tokens*: the
  summarization call replays the
  already-cached prefix, so it is mostly cache reads. The extension does the
  same: session model, `ctx.getSystemPrompt()`, the active tool definitions in
  active order (a mismatch there costs cache hits, never correctness), and — the
  key to actually hitting the cache — the session's *last real outgoing
  messages*, captured from the `context` event (see the cache section below)
  rather than reconstructed from entries, with the instruction as a
  final user message: one `<system-reminder>` holding the trigger notice
  ("the user has triggered a /compact command" vs "the conversation context
  window is running out") directly above the verbatim instruction, preceded by
  any `/compact <instructions>` as a "## Compact Instructions" reminder. The
  stored summary gets a continuation preamble baked in ("This session is being
  continued from a previous conversation that ran out of context…") plus a
  pointer to the session JSONL with a NEVER-read-it-whole warning — details
  the summary lost stay grepable instead of gone, and `read`/`grep` are
  safe-tier tools, so following the pointer never prompts, auto mode included.
  All inside pi's own hardcoded `<summary>` frame. A previous compaction's summary lives
  in the *live* context but is excluded from `messagesToSummarize`
  (prepareCompaction starts after that entry, handing the text over
  separately) — it is reattached as the leading `compactionSummary` message,
  the exact shape the live context carries, so convertToLlm renders the same
  bytes the cached prefix holds and re-compactions stay cache reads too.
- **Reasoning mirrors the session's thinking level.** The call sends
  `reasoning: ctx.thinkingLevel` (with `off`→none). This began as a deliberate
  omission — `reasoning` fails closed on providers pi's compat data mispredicts,
  the classifier's documented trade — but that reasoning does not apply here and
  omitting it turned out to be the last thing keeping the cache cold (see below).
  Unlike the classifier, compaction runs the *session's own* model, already
  proven to accept the level, and `streamSimple` clamps an unsupported level down
  rather than erroring — so mirroring never fails closed. It also restores the
  extended-thinking behavior for free.

All three reasons (manual, threshold, overflow) take this path; any failure —
no auth, timeout, empty summary — returns nothing and pi's own compaction
serves: a different summary style, never a broken compaction. `CC_COMPACTION=0`
opts out entirely.

Verified live on a Luna session with the final shape: two /compact runs in one
session (48,356 then 30,838 tokens) both stored fromHook entries — preamble
first, transcript pointer with the warning, all nine sections, no tag bleed
(inline backtick *mentions* of the tags in the second summary are content, and
line-anchored extraction correctly ignored them).

### The cache miss, and the two-part fix (2026-08-07)

For a while the summarization call read `cacheRead: 0` on openai-codex even
though the surrounding session sat at ~78–96% cache hits. Passing
`options.sessionId` (pi's prompt_cache_key / session-affinity carrier, which
completeSimple otherwise omits) was necessary but not sufficient. Two things
were wrong, both now fixed:

1. **Reconstruction diverged from the cached prefix at message one.** The
   request was rebuilt from session *entries*, but per-request `<system-reminder>`
   injections (the memory index, the every-turn reminders) are added at request
   time and never become entries — so no reconstruction can reproduce them. The
   fix is *capture, not reconstruct*: a `context`-event listener stashes the
   exact `AgentMessage[]` the session last handed the provider (a held reference —
   pi `structuredClone`s the array per turn, and compaction is the last `context`
   handler, so it is the array actually sent). pi's agent loop builds a request as
   `transformContext` then `convertToLlm`; running the *same* `convertToLlm` on
   the captured array makes the message prefix byte-identical, and appending only
   the instruction leaves that whole prefix a cache read. The entry path survives
   as a fallback for when no turn has run yet (e.g. `/compact` first thing in a
   resumed session).

2. **The reasoning config is part of the cache identity.** Even with a
   byte-identical prefix, `prompt_cache_key`, tools, and system prompt, the
   request *still* missed — because it omitted `reasoning` while the session's
   normal requests sent it. On the Responses API that is a different request
   configuration and the cached prefix is not reused. Found by dumping the last
   normal payload and the compaction payload and diffing: everything matched
   except `reasoning`. Fixed by mirroring the session thinking level (above).

Measured after the fix (thinking high, ~48–56k-token context):

| provider / model | before | after |
|---|---|---|
| openai-codex `gpt-5.6-luna` | `input 49776, cacheRead 0` | `input 2094, cacheRead 47616` |
| anthropic `claude-haiku-4-5` | — | `input 10, cacheRead 13042, cacheWrite 44287` |
| openrouter `deepseek/deepseek-v4-flash` | — | `input 1402, cacheRead 51200` |

openai-codex and deepseek get near-total prefix reuse immediately (automatic
prefix caching keyed by `prompt_cache_key`, no explicit breakpoints). Anthropic
needed a third fix. At first it reused only ~13k (≈ system + tools) and re-cached
the ~44k of history. Two dead-end explanations were ruled out by experiment
before the real one: it is **not** `cache_control` breakpoint placement (adding
an explicit anchor on the history's last block changed nothing — still 13k) and
**not** the reasoning param (identical in both). The confirmed cause, found by
diffing the compaction wire payload against the session's last normal payload and
by A/B-ing `CC_CLEAR_THINKING`:

- The `context-management` extension (default-on for first-party Anthropic) puts
  `context_management: { edits: [clear_thinking_20251015] }` on every agent-loop
  request plus the `context-management-2025-06-27` beta. So the session's cached
  **message** prefix is stored in the thinking-cleared form.
- `completeSimple` bypasses `before_provider_headers`/`before_provider_request`,
  so the compaction request omitted both — sending full thinking blocks with no
  `clear_thinking`. On Anthropic that mismatch invalidates the *message* cache
  (system+tools are unaffected, hence they still read), so the whole history
  re-caches: cacheRead ~13k, cacheWrite ~44k.
- Fix: when `clearThinkingEnabled(...)` is true, the compaction call replays the
  same beta header and `clear_thinking` body edit (reusing context-management's
  exported helpers), so its message prefix matches the session's cache. Measured
  after: `input 10, cacheRead 56032, cacheWrite 1460` on `claude-haiku-4-5:high`
  — near-total reuse, matching the other providers.

So the compaction request must be a faithful replay of the session's request in
*three* dimensions the naive shape got wrong: the request-time reminder
injections (capture, not reconstruct), the reasoning config (Responses-API cache
identity), and — on Anthropic — the context-management beta + `clear_thinking`
edit. All three providers now produce valid fromHook summaries with near-total
cache reuse, and none fail-closed. (Any provider-specific request mutation an
extension adds via `before_provider_*` is invisible to `completeSimple`; a future
compaction refactor that routed through the same request builder would get these
for free — a point for the upstream pi PR.)
