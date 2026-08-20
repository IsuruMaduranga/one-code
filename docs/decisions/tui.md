# TUI

Part of [decisions](../decisions.md).

## Compact tool rendering — the Claude Code transcript look (unreviewed)

*2026-08-08.* The transcript was cluttered: every custom tool rendered through
pi's fallback (bold tool name + full JSON args + full output) inside a heavy
colored box, harness notifications printed their whole anti-confabulation
framing to the user, and thinking text was barely distinguishable from answer
text. Claude Code's transcript shows a one-line call (`● Tool(args)`), a
collapsed indented result (`⎿ …` + `+N lines (ctrl+o to expand)`), and hides
model-facing boilerplate.

**What was done:**

- **`extensions/lib/tui-render.ts`** (pure, unit-tested) provides
  `ccToolRenderers(label, spec?)` — `renderShell: "self"` +
  `renderCall`/`renderResult` producing the `●`/`⎿` layout with pi's native
  ctrl+o expansion (`options.expanded`), status-colored bullet
  (muted → success/error), a primary-arg heuristic for the call line
  (per-tool `title`/`result` overrides where the heuristic is wrong), and
  ANSI-aware width truncation on every line (pi-tui crashes on overwide
  lines — findings §3). Every One Code-registered tool spreads it in; pi's
  built-ins (read/bash/edit/…) keep their own upstream renderers.
- **Notifications render compact.** `task-notification`, `wakeup`,
  `subagent-message`, `subagent-result`, `workflow-result` get
  `registerMessageRenderer` components: one dim `✳ headline` line collapsed,
  full body on ctrl+o. The `systemNotification` framing stays in the model
  payload but is stripped from display (`notificationBody`) — it exists for
  the model, not the user.
- **Bash background starts** render `⎿ Running in background (task <id> ·
  log: …)` instead of the model-facing instruction paragraph; foreground
  bash delegates to pi's own renderer untouched.
- **Themes:** `toolPendingBg`/`toolSuccessBg` set to `""` (terminal default —
  pi maps the empty string to "no background"), which removes the box look
  for *all* tools including pi built-ins; `toolErrorBg` kept as the one
  remaining background signal. `thinkingText` moved from `gray` to `grayDim`
  (240 dark / 245 light) so thinking reads clearly dimmer than answer text —
  pi already italicizes it, and ctrl+t (`hideThinkingBlock`) remains the
  user's collapse toggle.

**Rejected:** overriding pi's built-in tool renderers for a bullet-style call
line on read/grep/etc. — re-registering seven built-ins to restyle them is
high-risk surgery for marginal polish, and the theme change already de-boxes
them. Also rejected: hiding notifications entirely (CC-like) — a dim one-liner
keeps the transcript honest about turn triggers.

## Built-in tools joined the ● language; banner cut to four lines (unreviewed)

*2026-08-08, same session.* With custom tools on `●`/`⎿` and pi's built-ins on
their own style (`$ cmd`, `edit path`), the transcript spoke two languages —
the user asked for one (`● Bash(command)`, like Claude Code).

- **`extensions/tool-style/`** overrides read/write/edit/grep/find/ls under
  their built-in names (the bash-extension mechanism, findings §2). Every
  model-facing field is passed through byte-identical (system prompt
  unchanged); execute delegates to a per-cwd instance of pi's real definition
  (worktree moves). Rendering wraps rather than reimplements —
  `ccWrapBuiltinRenderers` in the shared lib: `● Label(primary arg)` call
  line; the **base result component indented under a `⎿` elbow**, so pi's
  streaming, truncation, and ctrl+o expansion behavior stays upstream's.
  Edit keeps its own call component (the diff preview a permission decision
  depends on) with only the header line swapped (`● Update(path)`).
  Inner components live on `context.state`, never `lastComponent` — base
  renderers cast `lastComponent` to their concrete classes and would throw.
  grep/find/ls stay tier-gated: search-tools reconciles the active list on
  session_start/model_select either way. Bash reuses the same wrapper (in
  `extensions/bash/`), which also dropped the "Took Ns" timer that counted
  permission-prompt wait time as command time.
- **Trap that cost a debugging loop:** a padded Box's "blank" lines carry
  ANSI paint (`\x1b[49m…`), so `line.trim() === ""` is false — blank-line
  detection in renderers must strip ANSI first (`isBlankLine`). The stale
  render looked exactly like a stale jiti cache and wasn't.
- **Banner** (`extensions/branding/`): three keymap-dump hint lines became
  one curated line — only the controls a user can't discover (renamed dials,
  collapsed-state toggles, input prefixes, the ultracode keyword), led by
  `/hotkeys all keys` so the pointer to everything else survives narrow
  terminals (`fitItems` drops whole trailing hints instead of cutting
  mid-word). Sections collapse to one line: names when ≤3 items, counts
  beyond (a truncated name dump carries no information). Startup warnings
  point at their commands (`(/lsp for status)`, `(/mcp for status)`), and the
  LSP one is capped at one line — the full server error stays in `/lsp`.

Verified live: `● Read/Grep/Update/Bash/LS` with `⎿` results, edit's diff
preview intact before approval, `seq 1 30` showing pi's "(25 earlier lines,
ctrl+o to expand)" under the elbow, banner at 170 and 80 columns.

## Thinking collapsed by default, expandable with ctrl+t (unreviewed)

*2026-08-08, follow-up to the same complaint.* Even dimmed and italic, visible
thinking still read as answer narration. pi already has the exact mechanism
Claude Code uses — `hideThinkingBlock` (persisted global setting, toggled by
ctrl+t and /settings) collapses each thinking run to a one-line label, and
`ctx.ui.setHiddenThinkingLabel()` is a public extension API for the label
text — so One Code adopts it instead of building rendering of its own (assistant
message rendering is not extension-replaceable anyway).

- **`branding` defaults `hideThinkingBlock: true` exactly once**: only when
  the key is *absent* from `~/.pi/agent/settings.json` (pure decision helper
  `shouldDefaultHideThinking` — a present key, either value, is the user's
  choice and is never overridden; an unparseable file is left alone). Write
  goes through pi's exported `SettingsManager` (locked merge-write).
- **Label**: `✻ Thinking… (ctrl+t to expand)`, set on every `session_start`
  (pi resets it to "Thinking..." on /reload via `resetExtensionUI`).
- **Timing caveat (finding)**: pi creates its runtime `SettingsManager` — and
  caches the file in memory — *before* extensions load, so the written default
  lands from the **next** session; the install session still shows thinking
  expanded until the user toggles.

Verified live across a restart: first launch writes the key, second session
renders `✻ Thinking… (ctrl+t to expand)`, ctrl+t expands to the dim italic
text and back, choice persists.

**Verified live** (tmux capture, deepseek-v4-flash-free): boxless transcript,
`● Todos(2 items)` / `● Task Output(<id>)` call lines, collapsed results,
`✳ Background bash … completed. (+2 lines, ctrl+o to expand)` notification,
ctrl+o expanding/collapsing both, thinking at `38;5;240` italic, no crash at
170 cols; 789 unit tests green.

## Fullscreen (alt-screen) for Claude Code's clean exit — a setting, not extension code (unreviewed)

Claude Code runs its whole session in the terminal's **alternate screen
buffer** (`ESC[?1049h` on start, `ESC[?1049l` on exit), so quitting restores
the terminal to whatever preceded it and CC prints only a one-line resume hint.
One Code's default looked different: pi's `TuiMainScreen` (inline, main buffer)
leaves the banner and whole conversation in scrollback after exit.

pi already has the machinery — `TuiAltScreen` (mode `"fullscreen"`), whose
`.stop()` writes `ESC[?1049l` and then pi prints `To resume this session:
pi --resume …` (`interactive-mode.ts`). It is gated behind the `tuiMode`
setting (`"regular"` default vs `"fullscreen"`), marked *experimental* by pi.

**Decision: recommend `tuiMode: "fullscreen"` as the One Code experience, but
deliver it as a documented user/global setting — not extension code.** The
renderer is a pi-core startup choice: it is built once from
`--tui-mode <mode>` (CLI) or `settingsManager.getUiMode()` (settings.json), and
the live switch (`switchUiMode`) is **private** to pi's `InteractiveMode` with
no extension-facing hook. A One Code extension therefore cannot set or flip it.

- **Rejected — flip it from an extension:** impossible; no API reaches the
  renderer, and it is read before/independent of which package loads.
- **Rejected — One Code writes the user's global settings on load:** invasive
  (mutating user config the package doesn't own) and it would change plain `pi`
  everywhere, not just One Code sessions — the setting cannot be scoped to
  "this package is active."
- **Chosen — document the toggle.** Set `"tuiMode": "fullscreen"` in
  `~/.pi/agent/settings.json` (global, per-user; right for a user who always
  runs One Code), or a project's `.pi/settings.json` (project settings override
  global — `deepMergeSettings`), or `pi --tui-mode fullscreen` ad-hoc. `/settings
  → Interface layout → regular` reverts.

**Trade-off (accepted):** alt-screen means the conversation does not persist in
terminal scrollback after quit — that is the whole point of the clean exit, and
`pi --resume` covers re-entry.

**Correction (2026-08-10, found live):** the setting alone does NOT give the
clean exit on pi 0.84.1. The alt screen engages (verified via tmux
`alternate_on`), but pi's quit path *deliberately* transfers the transcript to
the main buffer: `stopInteractiveTui()` switches back to the regular renderer
and repaints everything (`switchTuiMode("regular")` + `renderNow()`) before
stopping — `TuiAltScreen`'s `preserveScreen` clean exit exists but is
unreachable from settings. The bundled app therefore overrides
`InteractiveMode.prototype.stopInteractiveTui` in `app/bin.mjs` (exact-pinned
pi makes the touched internals stable; falls back to stock behaviour on any
surprise) to stop the alt screen with `preserveScreen: true` — verified live:
exit leaves only the resume hint, like Claude Code. Package-variant users
still get the transcript-dump exit until the upstream exit-preserve option
lands (upstream_prs #8). The mid-session `/settings` renderer switch is
untouched.

**Extension (2026-08-14, unreviewed): regular mode gets the clean exit too.**
A user report (screenshot) showed `/quit` in terminal (`regular`) mode leaving
the whole UI — banner, editor, footer — in scrollback. That was stock pi
behavior by design (`TuiMainScreen.beforeTerminalStop` just parks the cursor
below `previousLines` and newlines), and the bin override only handled
fullscreen. The override now also covers `renderer.mode === "regular"`: it
erases the on-screen part of the working area (cursor up
`hardwareCursorRow - previousViewportTop` rows, then `CR` + `ESC[0J`, plus
best-effort kitty-image deletes) and stops with `preserveScreen: true` to skip
the stock cursor-park. **Physical limit:** only the viewport is erasable —
lines already scrolled into terminal scrollback stay there (clearing them
takes `ESC[3J`, which would also destroy the user's own shell history). So a
short session exits fully clean; a long one keeps its older transcript in
scrollback, CC-like. Live-verified in tmux (short session → only the shell
prompt remains; 120-line expanded output → viewport cleared, prompt at top,
older lines retained in scrollback; fullscreen exit unchanged). Same caveat as
before: this lives in `app/bin.mjs`, so **plain `pi` runs (the package
variant) still get the stock leave-everything exit** — no extension API
reaches `InteractiveMode` — until upstream_prs #8 lands.

**Trap this surfaced (finding §10.16):** the setting key was `uiMode` in the
pinned reference clone (v0.83.0) but was renamed `tuiMode` in installed pi
(v0.84.1); a `uiMode` key is silently ignored on 0.84.1. Clone re-pinned to
`v0.84.1` to match.

Set in `~/.pi/agent/settings.json` on 2026-08-10; live clean-exit behavior to be
confirmed by the user.

## Render memoization: components cache by width (2026-08-10)

pi-tui calls `render(width)` on **every mounted component on every frame**
(~60fps during streaming, every keystroke; fullscreen mode additionally
re-measures the full unclipped scrollback to compute scroll height) — findings
§15. Our `linesComponent` recomputed `build(width)` plus `truncateLine`'s
per-character ANSI scan on every call, so every historical `●`/`⎿` row taxed
every frame for the life of the session. Profiled on a 750-entry thread:
`lib/tui-render.ts` was the largest app-level CPU consumer during typing
(~0.5s self time per 10s, plus ~1s induced in pi-tui width/wrap utils).

**Decision:** memoize by width inside the component, and rely on the
factory-per-state-change contract for correctness:

- Any state change (spinner tick, args streaming in, result arriving, expand
  toggle) makes pi re-invoke `renderCall`/`renderResult`, minting a **fresh
  component with a fresh cache** — so within one component's lifetime `build`
  is pure and a `Map<width, lines>` (capped at 4 entries) cannot go stale.
- `invalidate()` clears the cache — that is the path pi-tui uses for theme
  swaps and resizes.
- The `ccWrapBuiltinRenderers` wrappers cache only when the call/result is
  settled (`!isPartial`): a live base component may stream internally without
  a factory re-run, so in-flight rows stay uncached.
- `truncateLine` gained the structural fast path: raw length bounds visible
  width (escapes only add), so `line.length <= width` returns immediately —
  the hot path for nearly every line; the scan itself now uses a sticky
  module-level regex instead of per-character `slice().match()` allocations.

Verified: same typing/scrolling profile after the change — `truncateLine` and
`tui-render.ts` no longer appear in the top-30 functions at all; remaining
per-frame cost is pi-tui's own (upstream candidates: `docs/upstream_prs.md`
#2-#4). Unit tests pin the contract (build-once-per-width, invalidate clears).

**Rule for future renderers:** a component returned from
`renderCall`/`renderResult`/`registerMessageRenderer` must memoize its
`render(width)` (use `linesComponent`, or replicate its cache) — an uncached
component re-renders 60×/s for as long as it is mounted, and the cost
compounds linearly with thread length.

## Live-activity chrome: verb spinner, token counter, effort note (2026-08-16, unreviewed)

*(written while the user was away; review welcome)*

A frame capture of CC 2.1.233 showed three pieces of prompt-area chrome One
Code lacked; all three landed in one batch (`173b012`), matched to the
observed frames rather than the reconstructed source where they disagree
(the source gates spinner stats behind 30s/verbose; the frames show the
timer at 1s and tokens as soon as anything streams — we follow the frames).

- **The spinner** (`extensions/spinner/`): pi's `setWorkingIndicator` gets
  CC's asterisk cycle (`·✢✳✶✻✽` mirrored, 120ms, accent-painted — pi renders
  custom frames uncolored) and `setWorkingMessage` gets
  `"Verb… (elapsed · ↓ N tokens)"` on a 1s ticker. The verb is random per
  turn from CC's 187-entry SPINNER_VERBS verbatim; tokens are CC's estimate
  (streamed chars/4 via `message_update`, compact-formatted like CC's
  formatNumber). **Not replicated**: the glimmer/shimmer animation (pi
  renders the message as plain text) and the rotating tip lines (CC's tip
  registry carries frequency/relevance machinery; low value for the cost).
- **The context token counter**: CC shows a right-aligned `58197 tokens`
  directly above the input (raw number, no separator — per the frames).
  Ours is an above-editor component widget fed by `ctx.getContextUsage()`,
  refreshed on message_end/agent_end/session_start. Constantly re-setting
  it also keeps it *last* in the above-editor widget stack (setWidget order
  is last-write order), i.e. adjacent to the input like CC.
- **`· esc to interrupt`** appends to the permission-mode line only while
  the model streams (`agent_start`/`agent_end` toggle a flag into
  `modeBadge`) — CC's mode line does the same.
- **The effort note** (`effort/`): CC flashes `● high · /effort`
  right-aligned above the input after an effort change; ours shows for 5s
  on `thinking_level_select` or `/effort`, using CC's symbols (○ low,
  ◐ medium, ● high, ◉ max — pi's extra rungs map to the nearest) and
  keeping ultracode's ✦ badge.

`formatDuration` (humane elapsed: 45s / 1m 7s / 2h 5m) and `alignRight`
graduated to `lib/tui-render.ts`; the workflow viewer re-exports
formatDuration so its import surface is unchanged.

## Turn-duration line and the "away" recap (2026-08-16, unreviewed)

Two CC prompt-area features that share a display mechanism — a display-only
session entry (`appendEntry` + `registerEntryRenderer`), which pi keeps out
of the LLM context, so neither line ever becomes something the model reads
back. Both matched to CC's reconstructed source, then verified live in tmux.

- **`turn-duration/`** — CC's `✻ Cooked for 5m 12s`, appended after every
  turn (`agent_start`→`agent_end` elapsed). The verb is random per turn from
  CC's 8-entry TURN_COMPLETION_VERBS (past-tense, distinct from the spinner's
  gerund list); `✻` is CC's TEARDROP_ASTERISK; dim; no minimum-duration
  threshold; defaults on like CC's `showTurnDuration` (`CC_TURN_DURATION=0`
  off). CC's optional token-budget suffix is its separate `/budget` feature
  and is skipped.

- **`recap/`** — CC's `※ recap:` "while you were away" summary. Generation
  mirrors CC's `services/awaySummary.ts`: a cheap **same-containment** model
  (`pickEconomicalContainedModel`, the `getSmallFastModel` analog — the
  session transcript goes to the model, so containment applies exactly as for
  the web_fetch reader), CC's **verbatim** prompt, only the last 30 captured
  messages, `※` = REFERENCE_MARK, dim, display-only. It **does not** reuse
  the session prompt cache the way compaction does — the initial hypothesis
  was that it would, but the source shows CC makes a small standalone call
  here (`skipCacheWrite`, empty system prompt). Best-effort throughout: any
  failure shows nothing.

**Deviations from CC (deliberate):**
1. **Trigger is an idle timer, not 5-min terminal blur.** pi exposes no
   focus/blur event (checked the `ctx.ui` surface — `notify`, `setWidget`,
   `onTerminalInput`, no DECSET-1004). Closest faithful substitute: a timer
   armed at turn end, reset on any keystroke (`onTerminalInput`), cleared
   while a turn runs, at most one recap per user turn (CC's
   `hasSummarySinceLastUserTurn` guard). Default 5 min (CC's `BLUR_DELAY_MS`);
   `CC_RECAP_IDLE_MS` overrides, `CC_RECAP=0` off.
2. **Sends the active tool definitions, not CC's `tools:[]`.** A history
   carrying `tool_use` blocks is rejected by some providers when no tools are
   declared; the small token budget + "write 1-3 sentences" instruction keep
   the model answering in text rather than calling one.
3. **Session-memory block omitted** from the prompt (CC prepends it) — keeps
   the extension decoupled from One Code's memory extension. The recent
   messages carry enough "where we left off."

Default-on is a divergence from CC, which growthbook-gates the away summary
off for third parties (`tengu_sedge_lantern`, 3P default false); shipped on
here because the feature was explicitly requested.

## Interrupted-turn line, and suppressing pi's "Operation aborted" (2026-08-20, unreviewed)

CC's `InterruptedByUser` line — dim `Interrupted · What should Claude do
instead?`, rebranded to `… One Code …` — shown when the user aborts a turn
(Esc). Same display mechanism as the turn-duration/recap lines: a display-only
`appendEntry` + `registerEntryRenderer`, out of the LLM context so the model
never reads a note about its own interruption. Verified live in tmux (both the
plain `pi` shim and the bundled app).

- **`interrupted/`** — on `agent_end`, if the turn's last assistant message
  carries `stopReason: "aborted"` (pi's mark for an Esc/`ctx.abort()`), append
  the dim note. Detection is the shared pure `lib/interrupt.ts` `wasInterrupted`
  (duck-typed over `{role, stopReason}`, keys off the LAST assistant message —
  matching CC's `ERROR_MESSAGE_USER_ABORT`).
- **turn-duration suppresses itself on the same signal.** An interrupted turn
  shows the note *instead of* `✻ Cooked for …` — CC gates its turn-duration
  render on `!aborted`, so turn-duration now reuses `wasInterrupted(event.messages)`
  and returns early.

**Deviation: removing pi's red "Operation aborted" needs an app-layer patch,
not the extension API.** pi's core renders its own red abort line for an aborted,
tool-call-free assistant message (`AssistantMessageComponent.updateContent`,
`assistant-message.js`), and it sets `message.errorMessage = "Operation aborted"`
in the interactive `message_end` handler **after** extension handlers have run —
so the extension can neither pre-empt the string nor stop the line. Left as-is
that abort line duplicates our dim note. `AssistantMessageComponent` is exported,
so `app/bin.mjs` monkeypatches its `updateContent` (same discipline as the
`stopInteractiveTui` exit patch: guarded try/catch, exact-pinned pi,
re-verify on every pin bump): for an aborted, tool-call-free message it runs
the original with `stopReason` briefly coerced to `"stop"` — the only branch
that reads it for that case — then restores it, so pi skips the red line while
nothing downstream (the `interrupted` extension's `agent_end` check, session
persistence) sees a mutated message. Aborted *tool calls* are left alone (pi
surfaces those on the tool component). **App-only**: package-variant users
(`pi install one-code-extension` on stock pi) still see pi's red line, since
the extension layer cannot reach it — same limitation as the exit patch.

## Custom footer: all-in cost, labelled metrics, provider-qualified model (2026-08-19)

*2026-08-19.* pi's built-in footer renders a dense token line
(`↑1.1M ↓44k R6.9M CH0.0% $0.745 12.0%/1.0M`) whose raw ↑/↓/R/W counters mean
little to a user, and its cost/cache-hit reflect the **main session only** — the
in-process subagents, the auto-mode classifier, and the reader-style one-shots
are all structurally invisible to it (findings §15). We replaced it with One
Code's own single line via pi's `ctx.ui.setFooter` hook (the same shape as the
banner's `setHeader`), keeping what a user watches and dropping the rest.

**What was done:**

- **`extensions/footer/`** — `footer-line.ts` (pure: `buildFooterLines`,
  `computeMainUsage`, `formatCost`, path head-truncation) + `index.ts` (thin
  wiring calling `setFooter`) + `pr.ts` (a `gh pr view` lookup). The line reads
  `<path> ⎇ <branch>   usage: <tok>/<win> (<pct>%) · cost: $X · cache-hit: N% ·
  (provider) id · <effort>`. Labels are muted, values coloured; cache-hit is
  dim normally and warning/error when low, and **omitted entirely when the
  provider reports no cache activity** (matches pi — a non-caching provider must
  not show a permanent `cache-hit: 0%`). `CC_FOOTER=0` restores pi's built-in.
- **All-in cost via a usage bus** (`extensions/lib/usage-bus.ts`,
  `one-code:usage-recorded`). The footer sums the main session (from
  `sessionManager.getEntries()`, exactly as pi computes it) plus every
  out-of-band LLM call: subagents (per child message via a new `LiveSink.onUsage`),
  the auto-mode classifier (an observer-only `onUsage` on `ClassifierDeps` — no
  payload/verdict change), and the reader-style one-shots (web-fetch, recap,
  auto-mode setup) instrumented **once at their shared `withReasoningFallback`
  wrapper** rather than per call site. Cross-extension data goes over
  `pi.events`, per the module-isolation rule.
- **Performance:** `computeMainUsage` is an O(n) transcript scan, so it runs
  **only on `message_end`/`agent_end`** (where main entries change) and is
  cached; usage-bus, model, and effort events just repaint. Render is memoized
  by width through `linesComponent`.
- **Long paths** are head-truncated with a leading `…` (keeping the deepest
  folders) and the branch is kept; metrics are the protected core.
- **Provider-qualified model** (`formatModel`/`formatModelSpec` in
  `permissions/modes.ts`, beside `shortModelName`): `(openrouter)
  google/gemini-3.7-flash`. The banner's `model` and `subagents` lines were
  switched to the same helper so both surfaces name models identically — a short
  name alone hides which model an aggregator route points at.
- **Context counter consolidated:** the spinner's above-input token widget was
  removed; context now lives only in the footer as `usage:`.
- The effort/ultracode indicator moved inline after the model (no second line);
  the footer reads the shared `ULTRACODE_STATUS_KEY` (in `effort/slider.ts`) from
  `getExtensionStatuses()`.

**Known limitation:** a *background* subagent spawned before a `/clear`
(`newSession` fires `session_start` but not `session_shutdown`, findings §8) keeps
reporting after the footer reset, so its late cost lands in the next session's
total. Rare (only background subagents outlive a turn) and only a display figure,
so accepted rather than threading session identity through the bus.
