# Subagents & workflows

Part of [Decisions](../decisions.md).

## Subagents: what matches Claude Code and what does not

`extensions/subagents/` is our own (see the rejection of `pi-subagents` in
[`distribution.md`](distribution.md#community-packages-adopted-where-they-work)).
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

- **`run_in_background: true`** — detached runs. The child spawns as a resident
  `--mode rpc` process, the tool returns a task id immediately, output is spooled
  to `<sessionDir>/subagents/<taskId>/output.log`, and completion is delivered as
  a system notification (pi's `sendMessage` with `deliverAs: "followUp"`). Managed
  with `task_output`/`task_stop` (`extensions/background/`); the run registry lives
  in `runs.ts`. Killed on `session_shutdown`, not handed across `/reload`.
- **`send_message`** — reaches a resident background agent *live* (steered into
  its current turn, or a fresh turn when idle) or resumes a finished agent from
  its session file; a child can also `send_message {to: "main"}` to report
  mid-run. See `index.ts` and `rpc-turns.ts`.

**Sharp edge (fixed 2026-08-07):** a run that omits `agent`/`tasks` but carries
run options (`task`, `run_in_background`, a model override, …) now returns an
explicit "no `agent` given" error instead of silently dumping the agent catalog.
The old fallback conflated browse-intent with a run that forgot its agent; a
weaker model (observed on deepseek-v4-flash) read the catalog as a non-sequitur
and invented a wrong cause. `action:"list"` and a truly bare call still show the
catalog.

**Not implemented:** `isolation: "remote"`, which has no local equivalent.

## Permission modes and subagents

Permission mode lives in the permissions extension and is exported to child
processes via `CC_PERMISSION_MODE`; a child (marked by `PI_SUBAGENT_CHILD=1`)
inherits it unless a flag overrides. Plan mode is enforced twice on purpose —
the `tool_call` gate blocks mutations, and an every-turn `<system-reminder>`
tells the model not to attempt them.

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
- **The per-call field resolves anywhere, never silently.** The main model's
  per-call `model` field names a model and means it — a provider crossing is
  honored but announced, because the user configuring a key for a provider is
  not the user choosing to send this conversation there.
- **Claude Code conventions stay on Claude sessions (2026-08-17).** A
  `.claude/agents` frontmatter `model:` and `CLAUDE_CODE_SUBAGENT_MODEL` are
  Claude Code's own knobs, whose usual values ("sonnet") were written for
  Anthropic. On a Claude-family session they are respected as before. On any
  other provider they do not get to move a subagent — which inherits the parent
  transcript — off-provider: the env var is dropped (`applicableSubagentDefault`),
  and a cross-provider agent-file model is *not* honored (`resolveSubagentModel`
  skips it with a notice), so the automatic same-provider profile serves. A
  same-provider agent-file model or an in-provider alias still works everywhere.
- **The `subagentModel` setting is stamped, and a stale one is overridden
  (2026-08-17).** `/subagent` records the *containment identity* of the session
  it was set on (`subagentModelSetFor` = `modelIdentity().containment` — the
  plain provider for direct vendors, `provider:route:vendor` on a gateway, the
  same granularity `crossesProvider` uses, so a cross-*vendor* choice on
  openrouter is caught too). On resolve, a cross-provider setting is honored +
  announced *only* when the stamp matches this session (you deliberately chose
  it here); a stamp for a provider you have since left — or none at all (a
  hand-edited `settings.json`) — makes it **stale**, so a same-provider model
  runs instead with a notice telling you to re-set it here to use it. This keeps
  a global cheap-subagent default from silently shipping the transcript to
  another provider after you switch the session's model, while still letting a
  deliberate cross-provider choice stand. When a setting *is* in effect, the
  every-turn reminder names it for the main model (and, if cross-provider, notes
  the transcript goes there so it can pass a same-provider model per call).
- **Precedence:** per-call `model` > agent frontmatter > `subagentModel`
  setting > `CLAUDE_CODE_SUBAGENT_MODEL` (real env, then user/managed settings
  `env` block — project scope deliberately unread, same containment as
  `autoMode`) > automatic same-provider profile > session model. A knob that is
  contained away at this altitude — a cross-provider agent-file model off Claude,
  a stale cross-provider setting — is skipped like an unavailable one, falling to
  the automatic same-provider profile. A bad
  *configured* value degrades to the session model with a notice naming the knob;
  only a bad *per-call* value errors, because the model that wrote it gets the
  menu and can retry.
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

The provider-containment refinement (2026-08-17) was verified live on an
`openai-codex/gpt-5.6-terra` session carrying a hand-edited (unstamped)
`subagentModel: opencode/deepseek-v4-flash-free`: `/subagent status` and the
banner show it overridden to the same-provider automatic pick (`subagents
5.6-luna (auto)`), with the warning "…was set for a different provider than this
session … a same-provider model runs this subagent instead. Re-set it with
/subagent on this session to use it here." A model set via `/subagent` on the
session is stamped for that provider and stays honored + announced when it
crosses (with the reminder's informing line to the main model).

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
edge found during design: `noExtensions` drops One Code's permissions extension
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
next-turn reminder on `one-code:system-reminder` ("The user included the keyword
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

## send_message delivery, resident children, and default-model selection

(Graduated from the global handoff, 2026-08-15 — behavior notes and traps that
had no other home.)

`send_message` reaches background agents *live*: they run as resident
`--mode rpc` children (stdin command channel), so a mid-turn message is
steered into the running turn and an idle resident gets a new turn. Two traps
encoded in `child.ts`: a steer sent while the child is still booting (before
its `agent_start`) would run as its own turn — such messages queue locally and
flush at `agent_start`; and RPC children have `hasUI: true`, so every
`extension_ui_request` must be answered (`cancelled: true`), reproducing
print-mode's deny fallback. Foreground (non-background) agents still finish
before send_message can address them, and only their session files can be
resumed.

With no explicit default, subagents choose a smaller coding-capable model from
a shared same-provider/family role profile (for example an OpenAI Codex Sol
session uses Luna); the same resolver backs workflow `agent()` defaults too.
Opaque routers stay on the session model. The subagent default model remains
user-configurable via `/subagent` — an interactive picker in the TUI, or
typed: `/subagent provider/model-id|sonnet|opus|haiku|fable|inherit`,
`/subagent status`, `/subagent clear`. It persists the `subagentModel` setting
to user scope (auth-checked before saving, aliases kept literal so they keep
per-session resolution) and re-emits model status so the reminder/banner
update immediately.

Children message `main` back with their own send_message `{to: "main"}` — no
extra IPC: the tool returns the message in its result details and the parent
lifts it off the child's event stream (`toMainMessage` in rpc-turns.ts),
relaying it as a `subagent-message` notification; in children
(`PI_SUBAGENT_CHILD=1`) the tool is eager with a promptSnippet so the model
knows it can report, while the parent keeps it deferred. Not covered:
agent↔agent routing by name (the agent-teams design in the project roadmap)
and `isolation: "remote"`.

## The /workflows viewer (interactive run UI)

*(2026-08-15, unreviewed — written while the user was away; review welcome.)*

`/workflows` with no arguments in TUI mode opens an interactive full-screen
viewer (Claude Code's workflow UI): phase-grouped agent tree + per-agent
detail pane (model, tokens, duration, Prompt, Activity = live tool calls,
Outcome/Error), ↑/↓ navigation, tab run-cycling, `s` save-to-
`.claude/workflows/`, esc close. Non-TUI keeps the text listing (`custom()`
is a no-op there); `stop`/`log`/`list` subcommands stay textual.

Choices and reasons:

- **Pure module + thin component** (`viewer.ts` / `openWorkflowViewer` in
  `index.ts`), the same split plan-mode's approval dialog uses — all layout,
  key-decoding, and save-decision logic is unit-testable without pi, and the
  tests enforce the **width invariant** (no rendered line exceeds the given
  width — pi-tui crashes the whole app otherwise). All cells are cut/padded
  as plain text *before* painting so ANSI never enters the width math.
- **Liveness via a 500ms invalidate+repaint ticker, not per-RunHandle
  subscriptions.** The ticker also picks up runs that *start while the viewer
  is open* (the manager has no "run added" event), keeps the elapsed clock
  moving, and the width-memoized render keeps per-frame cost at a map lookup.
  Rejected: subscribing to each handle's `progress` — sub-second latency
  isn't worth the subscription lifecycle for a monitoring screen.
- **Per-agent data is folded at the source** (`AgentRecordStore` on
  `RunHandle`, fed by `record()`), not scraped from `recentEvents`:
  `RunProgressEvent` became a **discriminated union** (post-review — the
  optional-field bag let producers and consumers drift silently), gaining
  `prompt`/`preview` and an `agentUpdate` variant. `agent-session.ts` forwards
  each child `tool_execution_start` **structured** (`{name, argsSummary}` via
  `summarizeArgs`) through an optional `onUpdate` observer threaded via
  `AgentCallFn`; the `name(args)` join happens in the viewer, next to every
  other presentation decision. Replay has no tool calls in the journal, so
  replayed agents show "(replayed — activity not recorded)".
- **Records key on `(source, callIndex)`, not `callIndex` alone** — a nested
  `workflow()` child restarts its own callIndex at 0 while forwarding events
  into the parent's store; keying by index alone silently merged a child agent
  into the parent agent with the same index (caught by `/code-review`,
  regression-tested). `runChild` stamps `source: meta.name` on every forwarded
  event; the `▸ name` phase prefix stays as the visible grouping.
- **Save is two-step only when destructive**: `s` writes
  `.claude/workflows/<sanitized-name>.js` immediately when the target is
  absent or byte-identical; a differing existing file requires a second `s`
  (transient footer notice explains). Rejected: silent overwrite (clobbers a
  hand-edited saved workflow) and a modal confirm (heavier than the footer).
- **The renderer takes a `ViewerPaint` (`{fg, bold}`)**, not a single
  `paint(color, text)` with a "bold" pseudo-color (the first draft's approach,
  reversed by `/simplify`: the magic string was a two-file convention the type
  couldn't enforce). The wiring builds it from `safeThemePaint` +
  `safeThemeBold` (the bold guard now lives in `lib/tui-render.ts` beside its
  fg twin). The component also returns `dispose()` clearing its repaint ticker
  — the only teardown hook that fires when the overlay is dismissed by
  anything other than the user's own esc.

## The workflow status strip (below-editor entry + soft focus)

*(2026-08-16, unreviewed — written while the user was away; review welcome.)*

Claude Code's ambient workflow UI around the viewer: a persistent one-row-per-
run strip under the input box (`○/●/✗/◼ name description … n/m agents done ·
elapsed · ↓ tokens`), a `Running in background · /workflows to monitor and
save · <runId>` hint as the tool-result line, ↓ from an empty editor
soft-focuses the strip (↑/↓ rows, enter opens the viewer **half-screen** on
that run, `x` stops it, esc or typing returns to the editor), and plain
`/workflows` now fills the terminal (full-screen). Verified live in tmux
(160×45): focus in/out, half vs full height, enter-on-second-row opening
run 2/2, typing fall-through, the background hint line, and the strip
updating 0/3→3/3 with elapsed time.

Choices and reasons:

- **`setWidget(…, {placement: "belowEditor"})`, not `setFooter`.** pi's dock
  order is editor → below-widgets → footer, so the strip sits one line above
  where Claude Code puts it (CC renders below its mode line). Exact parity
  would mean replacing pi's whole footer with a reimplementation — a heavy,
  conflict-prone takeover for a one-line cosmetic difference. Rejected.
- **Soft focus via `ctx.ui.onTerminalInput`, guarded by editor identity.**
  Extension input listeners run before the focused component sees the byte
  and may consume it. Every consume requires (a) the captured **editor
  baseline** — the focused component duck-typed on `getText` at widget-factory
  time — to still be the real focused component (identity compare), and
  (b) for the initial ↓, `getEditorText()` empty. So the strip can never
  steal keys from permission dialogs, selectors, pop-up editors, or the
  viewer itself; and pi's ↑-history stays intact because recalled history
  makes the editor non-empty before ↓ ever matters. Any un-decoded key drops
  focus and falls through, so typing "just works" from the focused state.
- **The strip re-mints its widget component per change** (debounced 250ms +
  a 1s elapsed ticker while any run is live) with a width-memoized
  `linesComponent` inside — per-frame cost stays a map lookup (findings §15);
  `now` frozen per mint is fine at 1s granularity.
- **Half vs full viewer is a wiring-level height choice**
  (`min(rows/2, 30)` vs `rows − 2`) on the same component — pi's non-overlay
  `custom()` replaces the editor in the dock and leaves the transcript above,
  so "half-screen with the conversation visible" (CC's enter-from-entry view)
  and "full-screen tab" (CC's /workflows) are the same render at different
  heights, no second code path.
- **Finished runs stay in the strip** (CC keeps its entry too); rows cap at 3
  with a dim `+N more — /workflows` line. The strip only clears when the
  session has no runs at all.

## The viewer's drill-down layout (aligned to a CC frame capture)

*(2026-08-16, unreviewed — written while the user was away; review welcome.)*

The v1 viewer used a flat phase-grouped tree beside an always-on detail pane.
A frame-by-frame ffmpeg extraction of a real CC 2.1.233 screen recording
(104s, one frame/second) showed CC's actual structure is a **two-level
drill-down in bordered, titled panes**: Phases (✔/numbered, done/total
counts, declared-but-unstarted phases listed from meta) → agents of the
selected phase → full agent detail (`✔ Completed · model`, `tokens · N tool
calls`, 3-line Prompt preview with ⏎ expand, `Activity · last 3 of N tool
calls`, Outcome `Still running…`). v2 of the viewer replicates that. Choices:

- **Declared phases come from `meta.phases`, event phases merge after.**
  CC lists Synthesize before any of its agents exist; records alone can't
  do that, so run snapshots carry the meta-declared titles and
  `buildPhases` seeds groups from them (dim, countless until started).
  Child-workflow `▸ name` phases and ad-hoc `phase()` titles append.
- **`toolCalls` is counted uncapped on AgentRecord** — `Activity · last 3
  of 7 tool calls` needs the true total while `activity` keeps only a
  capped tail.
- **Durations are humane everywhere** (`45s`, `1m 7s`, `2h 5m`) — CC's
  strip showed `1m 7s` where ours showed raw seconds.
- **Esc backs out one level and closes at the top; q/ctrl+c close from
  anywhere.** Enter drills in at phases level and toggles the prompt at
  agents level (CC's `⏎ prompt`). `x` stops the run (CC also has restart/
  pause/filter — we don't have per-agent restart or pause semantics, so
  those are omitted rather than faked).
- **Mouse clicks were investigated and rejected for now**: pi never routes
  mouse events to extensions (main-screen mode has no mouse tracking;
  alt-screen mode's viewport listener registers first and consumes every
  mouse sequence). The workable-but-hacky path — overlay positioning +
  self-enabled SGR tracking, main-screen only — was parked in favor of a
  future upstream pi change. Keyboard covers the same selection.

## Subagents run in-process, aligned to Claude Code's Agent/SendMessage (2026-08-17)

**Decision.** The subagent tool no longer spawns a `pi` process per run. Every
path — foreground, `fork`, resume, and background/resident — now runs in the
main process via pi's SDK (`createAgentSession`), the way Claude Code's own
subagents do. The tools are also renamed to Claude Code's surface: `subagent` →
**`Agent`** (param `agent` → **`subagent_type`**, with `"fork"` a value),
`send_message` → **`SendMessage`**; the `tasks[]` batch parameter is **dropped**
(parallelism is multiple `Agent` calls in one turn, CC's own model).

**Why.** A spawned child was a whole second `pi` (~250 MB). On a memory-pressured
machine the OS SIGKILLed the newcomer ("Subagent produced no output (terminated
by SIGKILL)") — never seen in Claude Code precisely because CC runs subagents
in-process, sharing the parent's already-initialized services. In-process removes
the per-subagent footprint, matches CC's architecture, and reuses the proven
workflow-runner pattern.

**Architecture.**
- `extensions/lib/agent-loader.ts` (shared with the workflow runner) builds the
  `ModelRuntime` + a `noExtensions:true` `DefaultResourceLoader`; the shared
  `extensions/lib/permission-gate.ts` (moved out of `workflow/`) reattaches
  permission enforcement.
- `extensions/subagents/runner.ts` (`SubagentRuntime`) is built lazily once per
  session and shared across runs (one `ModelRuntime`, a per-agentType loader
  cache). Foreground/fork/resume use `SessionManager.create`/`.forkFrom`/`.open`;
  background/resident keep a live `AgentSession` and use its native
  `steer()`/reentrant `prompt()` for live messaging (the RPC stdin channel and
  its boot-lag buffering are gone). `session-turns.ts` tracks turns off
  `subscribe` events, settling on `agent_settled` (not `agent_end`, which can
  precede an internal retry/continue). `send-to-main-tool.ts` injects the child's
  `SendMessage`→main tool, which calls a parent callback directly (no
  event-stream parsing). `child.ts` and `rpc-turns.ts` were deleted; the
  surviving contracts live in `outcome.ts`.

**Fidelity (match CC by sharing the parent's live services).** A child gets a
curated extension set via `additionalExtensionPaths` — `claude-context`,
`file-tracker`, `system-reminder`, `tool-search`, `search-tools`, `skill`,
`web`, `web-fetch`, `notebook` — plus its agent's own system prompt and toolset,
but NOT the frontier chrome (banner/spinner/recap) or the orchestration
extensions (`Agent`/`workflow`). *(Superseded 2026-08-18 on the recursion
half: nested spawning is now an injected tool — see "Nested subagents"
below.)* MCP is **shared, not reconnected**: the
mcp extension publishes its live tool definitions on `MCP_TOOLS_CHANNEL`
(`lib/mcp-share.ts`) and the runner injects them as `customTools` closing over
the parent's open connections (a no-op when no servers are configured).

**Deliberate tradeoffs / gaps (deviations from the pre-existing spawn behavior).**
- **A child's tool calls go through the parent's REAL permission gate** (the
  permission bridge; see the dedicated decision below). This supersedes the
  interim fail-closed gate — a child inherits the parent's mode, is screened by
  the auto-mode classifier, and can raise a prompt that bubbles to the user, all
  matching Claude Code (findings §17.1). The fail-closed gate remains only as the
  fallback for a child with no parent bridge/UI (headless runs; the workflow
  runner was bridged too on 2026-08-18 — see the addendum in the bridge
  decision below). The parent-side return review (`SUBAGENT_ACTIONS_CHANNEL`) still runs on
  top, exactly as CC also classifies the hand-back (findings §17.2).
- **Injected MCP tools are active, not deferred** (customTools have no defer
  hook); acceptable for the typical small server count.
- **LSP diagnostics are NOT wired into children** — matching CC (findings §17.3).
  This was briefly tried (adding `lsp` to `CHILD_EXTENSIONS`) and reverted the same
  day: a child session is disposed via the raw `AgentSession.dispose()`, which never
  emits `session_shutdown` (verified in the SDK), so `lsp`'s cleanup never runs and
  any language server a subagent started leaked for the rest of the parent session
  (worsened by the shared loader cache — one un-reaped instance per language+root).
  There is no public API to fire the child's teardown. Since the main agent does the
  bulk of file editing and CC gives subagents no LSP anyway, this stays reverted.
  A **shared** language server (one per language+root, owned by the main session and
  reused by children) would sidestep the leak but hits the concurrency/worktree
  state problem CC cites — parked idea, see plan.md.
- **Crash isolation is reduced** (accepted, as CC accepts it): a hung run is
  bounded by a 30-min wall-clock `abort()`; a true OOM still takes the process.
- **Naming reversal.** This reverses [Tool names stay pi-idiomatic
  (snake_case)](tools.md#tool-names-stay-pi-idiomatic-snake_case) for these two
  tools only (a wider PascalCase migration is a separate question). pi's Anthropic
  "stealth" wire-rename could not deliver the names — its allowlist is fixed,
  stale (CC 2.1.75, no `Agent`/`SendMessage`), Anthropic-only, and never touches
  params — so the tools are registered under the CC names directly.

**Verified.** Live end-to-end via `test/e2e/rpc-subagent-test.mjs` (a persisted
`--mode rpc` main session, real Anthropic Haiku), all seven assertions green:
foreground `Agent`, `subagent_type:"fork"` (inherited-context reply),
`isolation:"worktree"`, `run_in_background` + resident completion, and
`SendMessage` to the resident child. Two architectural claims are asserted
out-of-band by sampling the main pi's descendant tree throughout the run:
**no nested `pi` process ever spawns** (the descendant tree stays pi-free — the
whole point of the rewrite), and **the parent's MCP connections are reused**
(with two servers configured, the MCP-server descendant count stayed at its
baseline of 2 — a reconnecting child would have spawned its own). tsc + full
unit suite green.

This closes the earlier "not yet verified live" gap: background/resident +
`SendMessage` steering and shared-MCP injection were only code-complete before;
both now pass live.

## Subagent permission bridge: a child's tool calls run through the parent's real gate (2026-08-17)

**Decision.** An in-process subagent's tool calls are gated by the parent
`permissions` extension's real decision pipeline, not the interim fail-closed
shim. A child inherits the parent's current permission mode, is screened by the
auto-mode classifier in `auto`, and — for a call that needs approval — raises a
prompt that renders on the parent's terminal. This replaces the earlier stance
("classifier not re-run in a child; net stricter") after we verified against real
Claude Code that this is exactly what CC does.

**Why.** Verified live in real `claude` 2.1.233 (findings §17.1): a subagent
inherits the parent's mode, and its tool calls hit the same gate — the classifier
in auto mode, and in manual mode a prompt that **bubbles to the user** (the
approval never enters the main agent's transcript, which is why an
orchestrator-only view sees the child's calls "just succeed"). Our fail-closed
shim (hardcoded `acceptEdits`, deny anything that would prompt) diverged from CC
and, worse, made a subagent unable to do ordinary gated work a user would happily
approve. CC parity here is both more faithful and more useful.

**Architecture (Approach B — a callback bridge, not loading the permissions
extension into the child).** Each child session has its own `EventBus`, so
`pi.events` does not cross the parent/child boundary; the only transport is a
plain closure threaded through our own call chain (the same shape as
`onMessageToMain`).
- `permissions/index.ts` publishes a decision closure on `SUBAGENT_GATE_CHANNEL`
  (`permissions/subagent-gate.ts`) at `session_start`. The closure —
  `evaluateChildToolCall` — mirrors the main `tool_call` handler's flow (rules,
  safety floor, classifier, ask) but is a **separate** function so the parent's
  own safety-critical handler is left byte-for-byte intact (its orchestration has
  no unit coverage; the pure helpers it calls do). Differences, all deliberate: it
  never mutates the parent's live `transcript` (the child action is appended to a
  copy for the classifier), it uses the child's own cwd, it uses a fresh
  `AbortController` signal (the parent's last `ctx.signal` may be from a settled
  turn), and it does not touch the parent's `pauseTracker` (a child is bounded by
  its wall-clock cap and the hand-back return review). It renders any prompt on
  the parent's live ctx (`lastReviewCtx`, now also refreshed at
  `session_start`/`agent_start`), through a shared promise-chain **mutex**
  (`serializePrompt`, applied to the parent's own prompts too) so a
  background/resident child and the main turn never drive `ctx.ui.select`
  concurrently.
- `subagents/index.ts` captures the closure and threads it into `SubagentRuntime`
  (a `getPermissionBridge` getter, read lazily) → `buildAgentLoader` →
  `permissionGateFactory`.
- `permission-gate.ts` calls the bridge for every child tool call (skipping the
  runtime-injected `neverGate` tools) and returns its decision; **any bridge error
  fails CLOSED** (deny). When no bridge is present — a headless run with no
  publishing parent — it keeps the original fail-closed local rules.

**Verified live (both directions, per the auto-mode discipline).**
- Auto mode: a child running `echo` is **allowed** (the old fail-closed gate would
  have denied a non-edit bash), proving mode inheritance + the bridge; a dangerous
  *delegation* is **blocked at spawn** ("Unauthorized Persistence"), proving the
  parent classifier path is intact.
- Manual mode (`test/e2e/rpc-subagent-permission-test.mjs`): a child's bash call
  raised **"Allow a subagent's bash?"** on the *main* rpc session, answerable over
  rpc, and approval let the command run — the prompt bubbling CC does and the old
  design could not. tsc + full unit suite green (incl. new bridge tests in
  `workflow-permission-gate.test.ts`: delegation, fail-closed-on-throw, and
  never-gate).

**Addendum (2026-08-18): the workflow runner is bridged too.** The original
implementation scoped the bridge to the subagent runner and left workflow agents
on the fail-closed fallback — which made workflows unusable in a gated (non-auto,
non-bypass) session: every bash call, even `ls`, was denied with "needs
interactive approval" and agents could only report their inability (hit live by a
real run on 2026-08-18). Fixed by threading the same closure through the workflow
side: `workflow/index.ts` captures `SUBAGENT_GATE_CHANNEL` (same pattern as
`subagents/index.ts`) → `StartRunOptions.getPermissionBridge` →
`AgentRunnerOptions` → both `buildAgentLoader` calls (base loader and the
per-agentType loaders). Prompt concurrency under fan-out is already handled by
the bridge's `serializePrompt` mutex — many agents prompting at once queue one at
a time. Verified live in default (manual) mode via
`test/e2e/rpc-workflow-permission-test.mjs`: a sync one-agent workflow's bash
call raised "Allow a subagent's bash?" on the main rpc session, approval let it
run, and the marker output came back in the workflow result. tsc + full unit
suite green. Possible UX follow-up (not built): an "allow for the rest of this
run" option for large fan-outs.

**Open follow-up.** The `serializePrompt` mutex serializes prompts we control, but
whether pi's underlying `ctx.ui.select` itself tolerates truly concurrent callers
was not separately stress-tested; the mutex makes that moot for our paths. Shared
parent auto-mode state (mode/rules/classifier) is intentionally shared with child
calls for fidelity; child calls deliberately stay out of the parent's transcript
and pauseTracker.

## The live subagent panel: CC's select+Enter transcript swap (2026-08-18)

**What was built.** Claude Code's below-editor agent tree, feel-complete: a strip
of live children (activity · elapsed · ↓ tokens), down-arrow soft focus, and —
the load-bearing part — **Enter swaps the visible transcript region to the
selected child's live session** (streaming text, markdown, tool blocks, spinner),
exactly like CC. Arrows only move the selection; Enter on `main`, esc, or typing
restores the main transcript; switching agents is select+Enter again (no in-view
tab/←→ — user-confirmed CC behavior). `x` / `ctrl+x ctrl+k` stop from the strip;
PgUp/PgDn scroll an open view.

**The transcript swap is a full-width NON-CAPTURING overlay, not a repaint.**
The long-held belief "pi extensions cannot repaint the host transcript region"
is true only of `ctx.ui.custom`'s default mode (it swaps the editor container).
Overlay mode (`{overlay: true, overlayOptions}`) composites screen-relative over
the visible viewport (pi-tui `compositeOverlays`), so `row:0, col:0, width:"100%"`
with a bottom reserve for the editor+strip covers the transcript region and
per-frame compositing restores it untouched on close. `nonCapturing: true` keeps
keyboard focus in the editor, so one `onTerminalInput` hook drives everything.
Rejected alternatives: the editor-container mode (reads as "attached below
main", not "switched into" — the v1/v2 design this replaced), and a modal
full-screen viewer with in-view agent switching (built, then deleted: not CC's
model). Wart accepted: `done()` → `hideOverlay()` pops the top of the overlay
stack, not ours by identity — so the panel keeps at most ONE overlay alive.

**Live data is an event-tap (`LiveSink`), not disk-JSONL.** The in-process
runner's `session.subscribe` already sees every child event; the sink forwards
tool start/end, settled assistant text, and — for streaming — the
`message_update` **message reference only** (the cumulative message arrives per
provider delta; text is extracted lazily at paint time, spinner-style, keeping
the hot path O(1) per delta). Rejected: tailing the child's session JSONL
(second source of truth, fs polling, no streaming granularity).

**Rendering matches the main transcript because it IS the main renderer.**
Assistant prose goes through pi-tui's real `Markdown` component with
pi-coding-agent's `getMarkdownTheme()`; instances are cached per settled block
(WeakMap) and reused via `setText` for the streaming tail. pi-tui cannot be
`require.resolve`d (pi-coding-agent's exports map is import-condition-only, no
`./package.json` subpath — findings §15), so `prose.ts#resolvePiTuiEntry()`
walks the node_modules candidates (nested under pi-coding-agent, then hoisted
sibling) and imports the entry by file URL; on failure the view warns once and
falls back to plain word-wrap. The view window is **tail-anchored** (scroll
counts back from the end; 0 follows the stream) and fills to exactly its height
— an overlay row not painted lets the main transcript bleed through.

**The strip tracks live work only (linger).** A run that finishes — including
an idle resident whose turn settled — stays in the strip for a 5s final beat
(`STRIP_LINGER_MS`, clock frozen at the turn duration), then drops; when new
work arrives (steer/resume) it wakes and rejoins. Runs stay in the registry
forever: the view, `/agents`, and `SendMessage` still reach them. This matches
CC (its tree drops finished agents) and was a user-reported divergence.

**Verified live** (tmux, Haiku): per-delta streaming inside the view (captures
2s apart show text advancing mid-code-block), markdown headings/bullets/fences
rendered, selection-without-swap, Enter-swap/switch/close, typing-exit with the
byte landing in the editor, PgUp scrollback, resume re-tracking ("Resuming…"),
and the 5s linger-then-drop. Full unit suite green.

## Nested subagents: children spawn agents via an injected tool (2026-08-18)

**What.** CC subagents can spawn subagents of their own (user-verified against
real CC 2.1.233: a `/code-review` fork fanned out five verifier agents, the
agent tree showing them nested with `└`). One Code now matches: every depth-0
child (foreground, background resident, fork, resumed) gets an injected
`Agent` custom tool; the runs it spawns appear in the panel as `└` rows under
their parent with live streaming, and are addressable by SendMessage.

**How — a parent-delegating tool, NOT the subagents extension in the child.**
`childAgentTool` (index.ts) is a custom tool (same mechanism as
`sendToMainTool`, passed via the runner's new `extraTools`) whose execute
calls back into the PARENT extension's `executeRun`. One `SubagentRuntime`,
one `RunRegistry`, one `LiveRunRegistry`, one permission bridge, one shared
MCP pool — a nested run is a first-class sibling, just linked by
`parentTaskId`/`depth`. Loading the subagents extension into child sessions
was rejected: jiti isolation would give each child its own registries and
runtime — invisible to the panel and the gate, and unboundedly recursive.

**Bounds and shape.** `MAX_SPAWN_DEPTH = 1`: children spawn grandchildren;
grandchildren get no spawn tool (all children share the main event loop — no
OS kill boundary). Nested spawns are **foreground-only, no fork/worktree/
background** (a child has no task_output or notification surface to manage a
background run with). The spawn call itself is never-gated (`NEVER_GATE` adds
"Agent", matching the auto-allowed main tool); every tool call the grandchild
makes still runs through the parent's real permission gate via the bridge.
Model resolution is the parent-side chain (agent's model → configured default
→ session model) with no per-call override. Grandchild records join the main
`RunRegistry` but are NOT reconstructable after a session resume (they live
in the child's transcript, which reconstructRuns doesn't scan) — accepted.
Auto mode's post-hoc whole-run action review is not emitted for nested spawns
(no parent toolCallId in the main transcript); per-call live gating covers it.

**Verified live** (tmux, gpt-5.6-terra session): a background child spawned an
`explore` grandchild — the strip showed `general-purpose  Running Agent` with
`└ explore  Searching …` beneath (separate elapsed/↓ tokens), Enter opened the
grandchild's live view (model resolved to the configured luna default), 24
grandchild tool calls ran gated, and the child's relay of the grandchild's
report arrived in the main completion notification.

## The shell manager joins the subagent panel (2026-08-18)

**What.** Claude Code's background-shell UX (matched to CC 2.1.234's shell
manager): a backgrounded Bash call renders `⎿ Running in the
background (↓ to manage)`; a "2 shells" chip sits under the editor; the first
↓ focuses the chip, Enter opens the Background list (`❯` rows, `↑/↓ to select
· Enter to view · x to stop · Esc to close`), Enter again opens a details
view (Status/Runtime/Command + a live bordered output box, `← to go back ·
Esc/Enter/Space to close · x to stop`); a second ↓ from the chip moves into
the agent rows, ↑ from agent row 0 comes back; the turn line gains `· 2
shells still running`. One Code matches all of it (pure layout + reducer in
`subagents/shell-panel.ts`, task mirroring in `lib/shell-tasks.ts`, 60s
list linger for finished shells so outcomes stay visible).

**Why it lives in the subagents extension, not `background/`.** Two reasons,
both structural:

- pi renders below-editor widgets in Map insertion order and **re-inserts a
  widget on every `setWidget` call** — two extensions ticking in that slot
  (the agents strip re-renders every second while children run) would reorder
  each other visibly every second. One widget owner means one stable layout.
- The ↓ axis is ONE focus flow (editor → shells chip → agent rows and back).
  As a single state machine in one input hook it is trivial; split across two
  extensions it needs cross-extension focus-handoff events plus duplicated
  editor-identity tracking.

No module state crosses extensions for this: the bash extension already emits
its live `BackgroundTask` objects (now carrying `command`) over
`TASK_REGISTER_CHANNEL`, so any consumer — the panel, turn-duration — mirrors
them with its own `trackShellTasks(pi)` instance and reads
`status`/`output()` live. `background/`'s generic " background tasks: N
running" line now counts only non-bash kinds (monitors).

**Verified live** (tmux, gated session with real permission prompts): every
state above, plus typing-passthrough (a typed char drops focus and lands in
the editor), x flipping a running shell to `(stopped)`, both sections
coexisting while an agent ran, and the ↓↓/↑ handoff in both directions.
