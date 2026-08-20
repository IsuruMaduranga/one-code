# Tools

Part of [Decisions](../decisions.md).

## Tool names stay pi-idiomatic (snake_case)

pi keys its built-in overrides and typed `tool_call` events on `read`, `bash`,
`edit`, `write`, `grep`, `find`, `ls`. We register custom tools in the same
style (`task_create`, `enter_plan_mode`, `subagent`). Users' Claude Code
permission rules still work: `matcher.ts` maps `Bash`, `Glob`, `WebFetch`,
`Task`, … onto our names. pi's Anthropic OAuth mode separately renames tools to
Claude Code's casing on the wire, so nothing is lost there either.

**Exception (2026-08-17):** the subagent tools were renamed to CC's exact
surface — `Agent` (param `subagent_type`) and `SendMessage` — since the wire
rename can't reach custom tools (its allowlist is fixed/stale/Anthropic-only and
never touches params). See [Subagents run
in-process](subagents-workflows.md#subagents-run-in-process-aligned-to-claude-codes-agentsendmessage-2026-08-17-unreviewed).
The rest of the surface stays snake_case.

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

Ours matches Claude Code's schema and drops the duplicate dependency.

The presentation started as one `ctx.ui.select` dialog per question (pi has no
native multi-question widget), then was rebuilt as **CC's full tabbed dialog in
one `ctx.ui.custom` component** (`ask-user/widget.ts`, pure state machine +
renderer; `index.ts` stays thin wiring) after screen recordings of CC 2.1.233
showed how much the plain dialogs were missing:

- **Tabs** — `← ⊡ Layout ⊡ Languages ✔ Submit →`; Tab/←/→ switch questions in
  any order, glyphs fill (⊠) as questions are answered, Submit shows a
  question→answer summary. Single-select auto-advances to the next unanswered
  question, CC-style.
- **Option previews** — the schema gains CC's `options[].preview` (ASCII
  mockup / code snippet), rendered in a bordered box beside the options,
  swapping with the focused option. Single-select only, per CC's guidance.
- **Notes** — "press n to add notes" on preview questions; returned as
  `Answer.notes` (CC's `annotations`). Capture-verified against
  `tools/eager-tools.json`; one deliberate divergence: CC writes answers back
  into the tool *input* ("collected by the permission component") — we keep
  them in the tool result, pi's natural channel; the model sees them either way.
- **Preview questions get no free-text row** (notes are their free-text
  channel) — matches the recordings; other questions keep an inline
  "Type something." row, and multi-select adds checkboxes plus an unnumbered
  "Next" to commit. Digit keys jump rows, and `rowNumbers` is the single
  source for display numbers *and* digit targets, so a digit can only activate
  a row whose number is visible.
- **"Chat about this"** — last row of every question; declines the whole batch
  with a result that lists the questions and tells the model to continue in
  chat (in CC's recordings the model then asks what to clarify — live-verified
  ours does the same).

Esc still cancels the batch (later answers are meaningless without the earlier
ones), and non-interactive sessions get an instruction to ask in the reply
instead.

Verified live in tmux against gpt-5.6-terra: full keyboard walkthrough (preview
swap on arrow-down, notes entry, checkbox toggling, digit jumps, typed
free-text answer, Submit summary) returned CC-style results, and the
chat-decline path produced the same conversational follow-up as CC's recording.

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

## Tool errors fail loud, never soft-fallback

A tool's `execute()` handler must, on a malformed / ambiguous / missing-required
call, return `isError: true` with the **corrective action named** — never a
plausible-but-wrong success. Reserve a non-error empty result for a genuine
no-op (an unsupported filetype, an intentionally cleared list), not for "the
operation failed" or "you called me wrong."

The archetype: `subagent` with run options but no `agent` silently returned the
agent catalog. A capable model self-corrects from that; a weaker one
(**observed on deepseek-v4-flash**, 2026-08-07) reads the catalog as a
non-sequitur, gets stuck, and — worse — invents a wrong cause (it blamed the
auto-mode gate). The failure mode is general: one response shape serving two
intents, a real failure reported as success (`isError` unset), or an error
message that states no next step. All three send a weak model chasing the wrong
fix.

A read-only audit of every `pi.registerTool` `execute()` (four parallel Sonnet
agents, one per tool group) found the same family across twelve tools; the
high/medium set was fixed in one pass:

- **Ambiguous overload** (like the archetype): `skill` (`args` without `skill`),
  `list_mcp_resources` (bad `server` name read as "no resources"),
  `enter_worktree` (empty `path` string fell through to *create*).
- **Silent failure / `isError` unset on a real failure**: `workflow`'s `agent()`
  swallowed a `WorkflowScriptError` (script-config mistake) into a `null` the way
  a genuine agent failure resolves — now it rethrows, matching `parallel()` /
  `pipeline()`; `tool_search` dropped typo'd `select:` names and reported the rest
  "Loaded", and its zero-match branch was a non-error — now unmatched names are
  surfaced and a total miss is `isError: true`; `lsp_diagnostics` after a
  mid-session server *crash* fell through to "install `<command>`" for an
  already-installed server, and a start failure was reported as a clean "no
  diagnostics" — now the crash reason is recorded and a recognised-but-unavailable
  language is an error (only a truly unsupported filetype stays non-error).
- **Destructive-before-validate**: `schedule_wakeup` cancelled the pending wakeup
  *before* validating params, so a malformed reschedule silently killed a running
  `/loop` — validation now runs first and a rejected call leaves the loop intact.
- **Misleading cause**: `exit_plan_mode` called cold blamed "the plan file is
  empty" instead of "you're not in plan mode"; `task_update` reported a
  self-reference as "Unknown task id"; `send_message` to an unstarted run said
  "No agent named …" in the same words as the catalog, hiding that the fix is to
  spawn the run first.

Deliberately left for later (logged, not silently dropped): the **lows**
(`send_message`'s `""`-prefix matching the only run; `monitor`'s unwrapped bad
`ws.url`; `notebook_edit`'s raw `ENOENT`; `schedule_wakeup`'s silent clamp) and
two **vendor** gaps outside our code — `pi-web-search` never sets `isError`
(would need a wrapper in `web/index.ts`), and `mcp/client.ts` swallows
`listTools`/`listResources` failures into empty arrays.

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
gone unused. The task tools now do the same after eight quiet turns, and also
flag a list with no `in_progress` task or several of them. A task list nobody
remembers to update is decoration. (The nudge originally lived on `todo_write`,
which was removed when Claude Code 2.1.233 dropped TodoWrite in favor of the
TaskCreate family.)

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

**Deliberately not copied:** OS sandboxing (pi's stance is to containerize);
harness-level command shaping such as blocking foreground `sleep`; background
agents with task notifications (still Phase 8); and mid-conversation
`role: "system"` messages, which pi's message types cannot express — our
user-message reminders are the closest equivalent. (The LLM safety classifier
that gates bash, once listed here as not copied because it needs a model call
per command, is now built — see [`auto-mode.md`](auto-mode.md).)

## Tier-aware tool surface: search built-ins for the tiny tier only

**Superseded 2026-08-17** (was "mid/low only"): with the 4-tier redesign,
grep/find/ls activate only for `tiny` — `cheap` now matches CC's Haiku surface
(no dedicated search tools; bash covers search). See
[`model-tiers.md`](model-tiers.md#grepfindls-belong-to-tiny-only-2026-08-17).
The original rationale below stands (pi registers but doesn't activate the
built-ins); only the tier boundary moved.


**Decision.** pi registers `grep`/`find`/`ls` but never activates them (only
`read`/`bash`/`edit`/`write` are active by default — findings §2). One Code
activates the three search tools at session start (and on model change) for
the **mid/low** prompt tiers only; **frontier keeps pi's lean default**
(`extensions/search-tools/`).

**Why.** Every captured One Code payload carried no search tools while the
mid/low tier prompts explicitly steer to "the search tools" — instructions
pointing at tools that did not exist in the request, a weak-model trap.
Frontier is deliberately different: Claude Code v2.1.81 ships no
Grep/Glob/LS to frontier models (verified in `tools/eager-tools.json`) —
bash covers search there, and CC's own frontier prompt keeps only the generic
"prefer dedicated tools" line. The tier classifier from the prompt-tier
decision is reused so prompt text and tool surface always agree.

**Rejected.** Activating unconditionally (anti-parity for frontier, wasted
schema tokens); editing the tier prompts to say "use bash grep" (weaker
models measurably do better with structured tools, which is why the tiers
exist).

## Subagent steering: injected catalog, fork hardening (unreviewed)

**Decision.** (a) The agent catalog is injected as an every-turn keyed system
reminder (`subagent-agents`), and the `subagent` schema descriptions point at
it; (b) a fork child's task is wrapped in a framing preamble
(`forkTaskMessage` in `subagents/child.ts`): inherited context is reference
only, do ONLY the task, the parent's background task ids are not addressable;
(c) `model`/`thinking` overrides on a fork run are rejected with a corrective
error.

**Why.** A captured weak-model payload showed the model had no way to know
agent names without a discovery call (Claude Code injects the agent-type
list in a system reminder). The fork preamble and override rejection close
the fork-confabulation incident (docs/features/tools/records/tool-ambiguity-hardening.md): a fork on
`thinking:"minimal"` abandoned its task and continued the inherited topic,
and the parent read the returned text as independent confirmation. Claude
Code silently *ignores* `model` for forks; rejection was chosen over silent
ignoring per the fail-loud convention.

**Rejected.** Renaming `agent` to CC's `subagent_type` (the tool is named
`subagent`, byte-parity is unreachable, and the pi-idiomatic naming decision
stands); silently coercing fork overrides (hides the caller's mistake).

**Reversed 2026-08-17.** The rename was later adopted: the tool is now `Agent`
with param `subagent_type`, and `send_message` is `SendMessage` — see
[Subagents run in-process](subagents-workflows.md#subagents-run-in-process-aligned-to-claude-codes-agentsendmessage-2026-08-17-unreviewed).
The fork override rejection and the injected catalog still stand.

## Background bash: override the built-in, gate before detaching (unreviewed)

**Decision.** `extensions/bash/` registers a tool named `bash`, overriding
pi's built-in (same-name registration — findings §2, the pattern pi's own
sandbox example uses). Foreground calls delegate to pi's real executor
(`createBashToolDefinition`, re-created per cwd). `run_in_background: true`
spawns detached in its own process group, returns a task id, spools to
`<sessionDir>/bash/<id>/output.log`, and registers a `kind:"bash"`
`BackgroundTask` — `task_output`/`task_stop` are kind-agnostic and work
unchanged. Completion notifications carry byte-identical text to
`task_output`, and legitimately-empty output is explicitly marked
`(no output — …)`. The permission gate / auto-mode classifier runs before
execute like any bash call — background bash is **not** auto-allowed, and the
gate fires before anything detaches (verified live).

**Why / rejected.** Full rationale and the rejected shapes (separate
`bash_background` tool; generalising `monitor`) in
[`../features/tools/records/background-bash.md`](../features/tools/records/background-bash.md), now implemented.
A separate tool name would diverge from Claude Code's single-Bash shape and
lose the existing `bash` permission rules for free.

## Deferral runs on all tiers; steering follows CC's channels (2026-08-10)

**Decision.** (a) Tool deferral (ToolSearch) applies on **every** tier, not just
frontier — the deferred-registry tools are deactivated and listed in the
deferred-tools reminder regardless of model; core tools (read/edit/write/bash/…)
never register as deferrable and stay eager. (b) Every harness-injected
notification shares `lib/notifications.ts`'s anti-confabulation preamble
(adapted from CC's). (c) MCP servers' `instructions` are injected as an
every-turn reminder in CC's format instead of being dropped.

**Why (a) reversed.** The original "frontier-only" was justified by a false
premise — findings §14 wrongly claimed CC ships Haiku all tools eagerly. The raw
captures (`haiku-4-6.json`, `latest-haiku.json`) show CC defers the long tail on
Haiku too. And it costs nothing to do everywhere: `pi.setActiveTools` edits
`agent.state.tools`, which *is* the request tool list, so deactivation omits a
tool from the wire on **any** provider (OpenRouter/deepseek included) — verified
live, 35→15 tools on `deepseek-v4-flash-free`. Provider-native deferral
(Anthropic `defer_loading`, OpenAI `tool_search_call`) is only a cache
optimization on top; without it, loading a tool mid-session invalidates the
prompt cache from the tools block down — an accepted tradeoff for cheap models.

**Rejected.** Keeping frontier-only as a deliberate divergence (weak models
fumble the indirection) — the user chose CC fidelity; the risk is documented and
revisitable. A One Code-specific notification format (CC's wording is
field-tested against exactly this hazard).

## CLAUDE.md, memory, and skills injected as the CC reminder stack (2026-08-10)

**Decision.** CLAUDE.md contents, the `MEMORY.md` index, and the skills listing
are no longer in the system prompt. They ride the first-user-message
`<system-reminder>` stack, prepended before the user's text in CC's fixed order
(deferred tools → subagent-models → agents → MCP → skills → `# claudeMd`), via
placement/order/suffix on the shared reminder queue (`lib/reminders.ts`,
`CONTEXT_ORDER`). CLAUDE.md + memory + `# userEmail` + `# currentDate` are bundled
into ONE byte-identical `# claudeMd` block (`extensions/claude-context` +
`lib/claude-context.ts`); discovery mirrors CC (global + project ancestors, not
pi's AGENTS.md-first loader). Tier-independent: the block is identical across
models — only the `# Memory` *spec* in the system prompt varies by tier (already
handled by `lib/memory.ts`).

**Why (reversed from "stay in the system prompt").** The goal is byte-identity
with CC's payload, which the user made explicit. CC puts this content in the user
turn (trust boundary: project/user-authored content isn't in the system role),
and the diff was visible and real. Injection is transient (pi's `context` event
runs on a `structuredClone`; the session keeps the clean user message), so
re-injecting every turn is safe on resume. The claudeMd block reproduces CC's
exact bytes including the trailing `\n\n` (findings §14).

**Rejected.** Keeping it in the system prompt (the earlier call — abandoned once
byte-identity became the requirement); a first-message idempotent-prepend without
the shared queue (the queue already models transient per-turn injection and
placement generalizes to all five reminders).

## `@path` imports and ONECODE.md in the claudeMd block (2026-08-20)

**Decision.** Two additions to the `# claudeMd` block (`lib/claude-context.ts`),
both no-ops when unused so the block stays byte-identical for anyone who touches
neither:

1. **`@path` imports.** Every context file's content is run through
   `expandImports` before it enters the block: each `@path` token is replaced in
   place with the referenced file's (recursively expanded) contents, matching
   Claude Code — recursion capped at 5 hops, cycle-safe, `~`/absolute/relative
   paths resolved against the *importing* file's directory, and `@` inside
   inline-code spans or fenced code blocks left alone. An unresolved reference is
   left as literal text. This makes the common `@AGENTS.md` reuse pattern (a
   one-line CLAUDE.md pointing at an existing AGENTS.md) work. The `MEMORY.md`
   index is generated, not authored, so it is NOT expanded.
2. **ONECODE.md family.** `ONECODE.md` / `onecode.md` / `OneCode.md` (first
   present per dir wins; the real on-disk casing is used so the `Contents of`
   line stays accurate on case-insensitive filesystems) carry One Code-specific
   instructions Claude Code never reads. The global one lives in `~/.one-code`
   (One Code's own state dir, chosen over `~/.claude` which is a read-only compat
   surface). They ride their **own `# oneCodeMd` block**, not the `# claudeMd`
   block — see the 2026-08-20 update below. (The `/memory` picker also offers
   ONECODE.md as an editable target — see
   memory-state.md#the-memory-picker-and-the-claudemd-over-limit-warning-2026-08-20.)

**Why.** `@AGENTS.md` in CLAUDE.md is how people reuse an existing AGENTS.md
without rewriting it, and CC supports it; we did not, so the token reached the
model literally. ONECODE.md fills the gap of "instructions for One Code that must
not go to Claude Code" — because CC only reads CLAUDE.md, an ONECODE.md is
automatically invisible to it, and users get a clean split without conditionals
in a shared CLAUDE.md.

**Fidelity.** No capture exists for CC's import-output bytes, so inline
replacement is a documented best-effort match of CC's behavior, not a
byte-verified reproduction; ONECODE.md is a deliberate, additive One Code
divergence that is inert (byte-identical block) when no such file exists.

**Rejected.** Global ONECODE.md in `~/.claude` (that dir is read-only compat) and
project-only with no global (less flexible); appending ONECODE.md at the very end
of the block instead of per-directory (loses the nearer-wins precedence that
mirrors CLAUDE.md ordering).

### Update (2026-08-20): ONECODE.md rides its own block, above CLAUDE.md

ONECODE.md no longer folds into the `# claudeMd` block. It rides a **separate
`# oneCodeMd` block** (`buildOneCodeBlock` / `discoverOneCodeFiles` in
`lib/claude-context.ts`), emitted `first-prepend` at `CONTEXT_ORDER.oneCodeMd`
(60) — after `# claudeMd` (50), so it sits closest to the user text, the
highest-precedence position in the context stack. Its preamble states the
instructions "take precedence over the CLAUDE.md instructions above … where they
conflict with CLAUDE.md, follow these." So ONECODE.md now wins over CLAUDE.md,
both by position and by explicit framing.

Two payoffs beyond precedence: the `# claudeMd` block goes back to **byte-exact
with Claude Code** (no One Code section wedged in), and the block is omitted
entirely when no ONECODE.md exists (nothing extra rides). Discovery for the block
is `homeOneCodeDir`-independent of `discoverContextFilePaths` — the `/memory`
picker still passes `homeOneCodeDir` to that function to list ONECODE.md as an
editable target, but the model-facing `# claudeMd` block no longer does.

**Why separate rather than a higher slot within `# claudeMd`.** The claudeMd block
is a byte-exact CC reproduction; a One Code section inside it breaks that fidelity
and muddies the trust framing (CC's block downplays itself with "may not be
relevant", the opposite of what One Code's own authoritative instructions want).
A distinct block carries its own override framing cleanly.

## CC's gitStatus block appended to the system prompt in a repo (2026-08-20)

**Decision.** In a git repo, One Code now reproduces Claude Code's `gitStatus:`
block (`extensions/system-prompt/git-status.ts`) and appends it as the very last
thing in the system prompt, after the `Current working directory:` line, matching
CC. Format and commands are byte-exact against `git-cc-sonnet.json` /
`git-cc-haiku.json` (findings §4): branch (`git branch --show-current`), main
branch (`origin/HEAD` → strip `origin/`, else a local `main`/`master`, else the
current branch), `git config user.name`, `git status --porcelain` (whole-output
trimmed), and `git log -5 --format='%h %s'` (trimmed). `collectGitStatus` takes an
injectable runner so the git calls are faked in unit tests; `formatGitStatus` is
pure and locked byte-for-byte against the capture.

**One-time snapshot, computed once.** CC labels the block "the git status at the
start of the conversation" that "will not update during the conversation", so it
is collected in `session_start` (fast synchronous git calls) and frozen for the
session — it re-computes on `/clear` (session_start re-fires) but never mid-turn.
This also keeps the system prompt byte-stable across turns: the block is a session
constant, identical across model tiers (CC confirms sonnet == haiku), so it sits
outside the (cwd, model, tier) EnvironmentInfo cache without breaking provider
prompt caching.

**Why.** Before this, the model's only git fact was the `Is a git repository:
yes/no` line — it never saw the branch, working-tree status, or recent commits
that CC's model sees. The block is high-value grounding (what branch am I on, what
is uncommitted, what shipped recently) and closes a real fidelity gap.

**Deliberately excluded: PR info.** CC's block carries no PR number and neither
does ours. The open PR is surfaced only in the TUI footer (`extensions/footer`),
never in model context — adding it would diverge from CC and put a `gh` network
call in the prompt path. (Question raised and settled 2026-08-20.)

**Fidelity caveat.** No capture of a *clean* tree exists, so the empty-`Status:`
rendering is best-effort (the dirty-tree bytes are locked). The whole-output
`.trim()` on `git status --porcelain` is what flush-lefts a leading-space
porcelain line when it is first — verified live against a temp repo.

## Foreground `sleep` is blocked; wait via background / monitor (2026-08-14)

Claude Code blocks a foreground bash command whose only job is to wait — a
top-level `sleep`, alone or leading a `sleep N && poll` / `sleep N; check`
chain — because it stalls the whole session for nothing, and steers the model to
the mechanisms built for waiting. One Code now mirrors it: the bash extension's
foreground path returns `isError: true` with guidance toward `run_in_background:
true` (completion arrives as a notification, no polling), the monitor tool (watch
a condition), or `schedule_wakeup`. The check (`bash/wait-guard.ts`, pure,
unit-tested) reuses the shell pre-gate's `parseCommand` and fires only when the
**first** top-level command is `sleep`: a brief `sleep` inside a larger command
(`build && sleep 2 && smoke`) is a legitimate pause and is left alone, a `sleep`
inside a script file is invisible anyway, and `run_in_background: true` with a
sleep is the sanctioned path and is never blocked (the guard is foreground-only).
Blocking (not warning) is deliberate — parity with CC, and chaining shorter
sleeps to poll is exactly the anti-pattern the guard exists to stop. It applies
in every mode, since it is a tool-shape rule, not an auto-mode safety check.

## Deterministic bash guards: a pipeline of instructive refusals (2026-08-17)

*(Supersedes and absorbs "Foreground `sleep` is blocked" above — the wait
guard is now one member of a family.)* Bash anti-patterns are refused
**pre-execution by deterministic parsing**, not left to prompt guidance: a
guard pipeline in `bash/guards.ts` (wait, poll-loop, orphan, interactive) and
worktree-session guards in `worktree/guards.ts` (git isolation, shared stash).
Modeled on the feedback family current Claude Code applies to Bash (observed
live in CC sessions; the sleep guard's ≥ 2s threshold and float/sub-2s pacing
exemption match CC's own implementation). Every message follows one shape:
**echo what tripped it, say why it's a problem, name the sanctioned
alternative, close the obvious workaround** ("Do not chain shorter sleeps to
work around this block"). New guards drop in as one pure function each.

**The guards.** Wait: a command *leading* with `sleep` ≥ 2s (provably shorter
passes as pacing; unprovable durations block — the model controls the
literal). Poll-loop: a foreground `while`/`until`/`for` that sleeps in command
position is the same stall spelled as a loop → monitor. Orphan:
`nohup`/`setsid`/top-level `&` lose output and exit status →
`run_in_background: true`; a `… & wait` pattern reaps its children and passes.
Interactive: TTY-requiring commands hang until the timeout (`vim`,
`git rebase -i`) or silently no-op (`git add -p` reads EOF and stages
nothing) → non-interactive equivalents named. Worktree git-isolation (active
worktree session only, blocking via `tool_call {block, reason}` **before the
permission prompt** — the worktree extension loads ahead of permissions): git
whose repository is decided at runtime (`xargs`/`parallel`/`find -exec`,
expanded `-C "$DIR"`, unresolvable `cd`) or that resolves into the shared
checkout / a sibling worktree is refused; git against unrelated repos passes.
Shared-stash: untagged `stash push`, `pop`, `clear`, ref-less `drop` are
refused with the tagged-push + apply-by-SHA recipe (the stash stack is
per-repo, shared across all worktrees and parallel sessions).

**Contract.** Positive-parse only: an unparseable command always passes (the
permission gate and auto-mode still apply) — with ONE deliberate fail-closed
exception: an unparseable command that visibly involves git inside a worktree
session is refused as "too complex to verify". Guards are steering, not
security; auto-mode remains the safety layer.

**The bug this fixed.** The original wait-guard was **silently disabled in
worktree sessions**: the `cd '<wt>' && (…)` input rewrite made `cd` the lead
command. Guards now read the model's original command via the rewrite's
preserved `ORIGINAL_COMMAND_KEY` (same fix shape as the permission matcher's).

**Rejected.** (1) CC's blanket fail-closed for worktree sessions — live CC
refused *every* command it deemed complex (even a git-less `for` loop) once
isolation was active, and bricked two of our own subagents mid-task; we scope
fail-closed to git, which is the actual invariant. (2) Blocking pagers
(`less`, `top`) — without a TTY they degrade to `cat` or fail fast on their
own; only genuinely hanging/no-op commands are guarded. (3) Guarding in
`execute()` for the worktree rules — blocking in the `tool_call` hook avoids
prompting the user for a command that would be refused anyway.

**Verified** by 46 unit tests over the pure modules plus live pi runs (json
mode, real model): the foreground-sleep, `git stash pop`, and `xargs git`
blocks all fired verbatim inside a real `enter_worktree` session — and an
unforced run showed the model choosing `run_in_background: true` on its own
from the updated tool description (steering working before any guard fires).

## CC tools: list_agents adopted, harness-specific ones diverged (2026-08-17)

Phase 4 of the CC-alignment initiative
([`features/cc-alignment/`](../features/cc-alignment/README.md)) triaged the
tools a live CC session exposes that One Code lacked.

**Adopted — `list_agents`** (CC's `ListAgents`): a deferred, read-only tool that
enumerates the agents *spawned this session* (name, type, and status —
running / resident / finished-resumable) so the model knows which ones
`SendMessage` can reach. Distinct from `Agent action:"list"`, which re-prints the
agent *catalog*. Auto-allowed (read-only) and mapped in `matcher.ts`
(`ListAgents`→`list_agents`).

**Diverged — deliberately absent** (CC-harness / Anthropic-platform features with
no place in a provider-neutral pi package; the user confirmed the Artifact class
is fine to skip):

- **`Artifact`** — publishes HTML/Markdown to claude.ai-hosted pages. Platform-specific.
- **`ReportFindings`** — structured code-review findings for CC's review UI. No One Code surface consumes it.
- **`ShareOnboardingGuide`** — uploads an ONBOARDING.md to an org guide service.
- **`PushNotification` / `RemoteTrigger` / `DesignSync`** — remote/desktop/design integrations of the CC app.
- **`CronCreate` / `CronList` / `CronDelete`** — scheduled *cloud* sessions. One Code's `schedule_wakeup` + `/loop` are intra-session only; a local cron would be a separate feature, not a CC-parity obligation. (This is why `/loop`'s autonomous-sentinel mode stays deferred — it needs `Cron*`.)

If any of these later gain a One Code equivalent, add the tool under its
snake_case name and revisit this list.

## Task reminder realigned to Claude Code's `task_reminder` (2026-08-19)

The stateful task list (`extensions/tasks/`) periodically nudges the model when
the task tools have gone unused, so a plan that no longer matches the work gets
cleaned up. Our nudge had drifted from Claude Code's into a home-grown one:
`nudgeMessage` branched on list state and emitted one of three custom strings —
"start tracking" (empty), "unfinished tasks, none in_progress" (stale), "more
than one in_progress" — and **returned nothing when every task was completed**.
That last gap was the visible bug: finish a list and no reminder ever suggested
clearing it, so the pinned widget lingered with an all-`✔` list until the model
happened to delete the tasks or the session cleared.

Realigned to CC's actual mechanism (`src/utils/messages.ts` `task_reminder`,
`src/utils/attachments.ts` `TODO_REMINDER_CONFIG`), because this is a fidelity
fix rather than a new divergence:

- **One verbatim message, always the same**, byte-for-byte CC's text except the
  tool names, which stay our snake_case (`task_create`/`task_update`) — see
  [Tool names stay pi-idiomatic](#tool-names-stay-pi-idiomatic-snake_case). Its
  operative line is "Also consider cleaning up the task list if it has become
  stale," which covers both the all-completed case and the mid-session pivot the
  user hit.
- **The current list is appended** (`#id. [status] subject`) so the model
  reasons over real state instead of the reminder guessing it. This is what lets
  the model notice everything is `completed` and delete it — CC keeps completed
  tasks pinned too, so the widget only clears once the model acts.
- **Trigger matches CC**: fire after `TURNS_SINCE_WRITE = 10` turns without a
  *mutating* task call, no more than once per `TURNS_BETWEEN_REMINDERS = 10`
  turns. Two independent counters (task use resets one, a fired reminder resets
  the other), the reminder counter initialized "cooled down" so the first nudge
  waits only on inactivity. Was a single 8-turn counter with no cooldown.

Dropped the `> 1 in_progress` check as part of going CC-faithful — a genuinely
useful signal CC lacks, but keeping it would have re-introduced a divergence in
the one place we were removing one. The widget itself is unchanged and stays
CC-faithful: pinned until the model deletes the tasks or the user runs
`/tasks hide`; it does **not** auto-hide on all-completed (CC's `TaskListV2`
returns null only on an empty list). Display/steering only — no payload-fidelity
lock, so no capture test to regenerate.
