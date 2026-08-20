# Memory & session state

Part of [Decisions](../decisions.md).

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
One Code had nothing, so temp files landed in `/tmp` or the project — and in
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

## Own state, borrowed config: `.claude` is read-only, One Code writes to `~/.one-code`

One Code sat in a three-way namespace muddle: pi owns `~/.pi` (sessions,
models.json — harness plumbing, invisible, and untouchable without forking),
`.claude` is Claude Code's directory, and One Code had started *generating*
state into the latter (plan files at first; memory was already there at
`~/.claude/projects/<slug>/memory`). Reading `.claude` deeply is the product —
"your Claude Code setup works on any model" is the pitch, so settings, skills,
commands, agents, plugins, and CLAUDE.md stay read-from-`.claude` forever. But
*writing* into a namespace another product owns invites collisions: Claude
Code also writes under `~/.claude/projects/<slug>/` and evolves that layout
without notice, and a user auditing "what did Claude Code do" finds artifacts
it didn't make.

The policy, in one line: **`.claude` is a read-only compat surface; everything
One Code generates goes to `~/.one-code`.** `extensions/lib/paths.ts` centralises
both roots — `claudeConfigDir()` (honouring `CLAUDE_CONFIG_DIR`, which Claude
Code itself supports and One Code previously ignored) and `oneCodeStateDir()`
(honouring `ONE_CODE_STATE_DIR`). Plan files moved to `~/.one-code/plans`
immediately, while the feature was a day old. `.one-code` joined the protected
dirs (the gate's own namespace must be as guarded in its new home as in the
old), with `.one-code/plans` excepted as working space.

### The settings schema followed (the compat reads were not enough)

"No demand yet — compat reads suffice" turned out to be wrong: One Code was not
only reading `~/.claude/settings.json` but *writing* its own keys into it —
`subagentModel` / `subagentModelSetFor`, `autoMode.classifierModel` /
`classifierModelSetFor`, the `/allow` rules, and the `/auto-mode setup` output.
That both polluted Claude Code's own config and, in the reported case, left a
value Claude Code cannot act on (a `subagentModel` of `opencode/gemini-3.7-flash`,
a model Claude Code has no access to) sitting in Claude Code's file.

So the One Code-native settings file now exists: `~/.one-code/settings.json` for
user scope, plus `~/.one-code/projects/<slug>/settings.json` per git repo (the
same slug the memory dir uses), both behind `extensions/lib/one-code-settings.ts`
(state root resolved against an explicit `home` so the settings loaders stay
hermetic in tests). Every One Code write moved there; no writer touches Claude
Code's files any more. The loaders read `~/.claude` (borrowed) *then*
`~/.one-code` (own, higher user-scope precedence, managed still the ceiling).
The one sharp edge: One Code's *proprietary* keys — the ones Claude Code does
not define — are read from `~/.one-code` and managed settings **only**, never
from `~/.claude`, so a stale value an older build left in Claude Code's file
stops applying (a leftover `autoMode.classifierModel` there is surfaced as a
`/auto-mode config` diagnostic pointing at the new home). Genuine Claude Code
keys (`permissions.*`, `autoMode.environment` / rule lists,
`CLAUDE_CODE_SUBAGENT_MODEL`) are still read from `~/.claude` for compatibility.

Two consequences fall out of "never write `.claude`". The `/auto-mode setup`
audit can no longer delete broad `permissions.allow` entries from Claude Code's
file; it removes only entries in One Code's own file and *warns* about the rest.
And `/allow` writes its rules to `~/.one-code` (global) or the per-repo file,
which `loadPermissionSettings` reads back alongside the borrowed `.claude`
ladder (rules only — `defaultMode` stays a `.claude` decision, so no new `auto`
injection path opens).

Still deferred: the memory-dir migration, which has a real tradeoff (sharing
memory with Claude Code on the same repo is arguably a feature) and waits on its
own decision.

## The `/memory` picker and the CLAUDE.md over-limit warning (2026-08-20)

Two Claude Code surfaces were missing in a project. Both now exist.

**Startup over-limit warning.** CC warns at startup when a context file passes a
soft char limit (~40k) — the file is bloating every turn — and points at
`/memory`. One Code raises the same via `ctx.ui.notify(..., "warning")` at
`session_start` (pi renders it as `Warning: …`, no ⚠ glyph — the codebase's
existing startup-warning style, e.g. the pi-version drift warning). The limit and
message live in `lib/memory.ts` (`CLAUDE_MD_CHAR_LIMIT`, `claudeMdLimitWarning`;
`N.Nk` rendering matches CC's "over the 40.0k-char limit (55.4k chars)"). It is
checked per loaded file, so a big AGENTS.md pulled in by `@import` is named on its
own — distinct from the MEMORY.md *index* load-limit, which is a different file
and a write-time check.

**The picker.** CC's `/memory` is a Memory panel (status line, numbered files with
descriptions, "Open auto-memory folder", a learn-more link) that opens the choice
in the external `$EDITOR`/`$VISUAL`. One Code now matches this with a focused
overlay (`ctx.ui.custom`) — pure `panel.ts` (state/keys/render) and `entries.ts`
(the list), opening via `open-external.ts` (`$VISUAL`→`$EDITOR`→OS opener,
detached; folders use the OS opener; the "$EDITOR" hint is printed on file opens,
as CC does). This replaced the old in-TUI `ctx.ui.editor` flow and its `files.ts`
(deleted): manual edits are no longer frontmatter-stamped, which is correct —
stamping ties to *model* writes, and CC's external-editor edits are unstamped too.

**Entries: what belongs in "our context".** The list is the CLAUDE.md family
(global + ancestors + cwd, the two primaries always offered/create-on-open),
`ONECODE.md` (global + per-dir — always shown, since One Code loads it directly),
and `AGENTS.md` **only when a loaded file `@`-imports it**. A standalone AGENTS.md
that nothing references is not in One Code's context (CC has no AGENTS.md concept
at all), so editing or trimming it changes nothing — showing it would mislead.
Reference detection reuses the import traversal: `collectImportedPaths` in
`lib/claude-context.ts` returns the transitive set of `@import` targets, and an
AGENTS.md shows only if its path is in that set. The same filter governs the
over-limit warning. cwd files render as `./name` (CC's relative form); the
learn-more link points at the One Code repo, not CC's docs.

**Offering `~/.claude/CLAUDE.md` does not breach "never write `~/.claude`".** The
global user CLAUDE.md is offered as "User instructions", matching CC's panel — a
reversal of the old in-TUI picker, which deliberately *excluded* it (the old
`files.ts` skipped the global CLAUDE.md precisely because that flow had One Code
`writeFileSync` the edited buffer back, which would have written the read-only
compat surface). The external-editor flow removes that reason: One Code only
`spawn`s the user's editor on the path and never writes `~/.claude` itself — the
user's editor does, on save, which is exactly what CC does. So the "read-only
compat surface" invariant (about *One Code* not persisting into `~/.claude`) still
holds. One Code also never programmatically creates a not-yet-existing target
(that would breach the invariant for the global file); create-on-open relies on
the editor materialising the file on save, as CC does.
