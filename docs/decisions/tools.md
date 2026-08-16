# Tools

Part of [Decisions](../decisions.md).

## Tool names stay pi-idiomatic (snake_case)

pi keys its built-in overrides and typed `tool_call` events on `read`, `bash`,
`edit`, `write`, `grep`, `find`, `ls`. We register custom tools in the same
style (`task_create`, `enter_plan_mode`, `subagent`). Users' Claude Code
permission rules still work: `matcher.ts` maps `Bash`, `Glob`, `WebFetch`,
`Task`, … onto our names. pi's Anthropic OAuth mode separately renames tools to
Claude Code's casing on the wire, so nothing is lost there either.

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

## Tier-aware tool surface: search built-ins for mid/low only (unreviewed)

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
