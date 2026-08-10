# Code review remediation

The first whole-codebase pass of `/simplify` + `/code-review` (2026-08-10), and
what came of it. Run report-first over the entire source tree (the code had
never been reviewed). Seven correctness findings were confirmed by an
independent verify pass; ~22 quality cleanups were applied and the more invasive
refactors deferred.

## Auto-mode gate hardening: four false "safe" verdicts closed (2026-08-10)

The shell pre-gate's contract is that it may **only ever conclude "safe", never
deny** — a gap costs one classifier call, never a bypass (see
[`auto-mode.md`](auto-mode.md)). The review found four commands reaching "safe"
without their real effect being weighed, plus one allow-rule class skipping the
classifier entirely:

- **A bare redirect with no command word** (`> /etc/hosts`) — the analyze loop
  `continue`d on an empty command name before it ever looked at the segment's
  redirects.
- **A read-only command's redirect** (`git log > outside.txt`) — the git/cd
  branches `continue`d before the write-target check ran.
- **`git -C <dir>`** whose directory escapes the working tree — the global-flag
  loop skipped `-C` and its value without validating the target.
- **`sort -o <file>`** — `sort` is fast-pathed as read-only, but `-o` writes an
  arbitrary path.
- **`Bash(sh -c *)` / `python -c *` / `node -e *`** allow rules — `isBroadExecutionRule`
  only recognised `run|exec|x` as a runner's escape hatch, so interpreter
  inline-code flags matched and returned `allow` without ever reaching the
  classifier.

**Fix keeps the contract.** Every change converts a false "safe" into an
escalation — none adds a deny path. The structural fix for the two redirect
gaps was to lift redirect checks to run **first for every segment** (a shared
`checkWriteTarget` closure), so no command-specific `continue` can skip a write
target — deeper than patching the bare-redirect case alone. `git -C`/`--git-dir`/
`--work-tree` now escalate when their directory leaves the working tree; `sort -o`
escalates as a write; interpreter `-c`/`-e` flags are treated as broad (which, if
it over-flags a runner's unrelated `-c`, only costs a classifier call — the safe
direction). All five are covered by regression tests
(`test/unit/auto-mode-shell.test.ts`, `test/unit/matcher.test.ts`).

**Live-verified both directions** (2026-08-10, `openai-codex/gpt-5.6-luna` in
`--permission-mode auto`, `logDecisions` on): plainly-safe commands (`cat`,
`git status`) resolved on the deterministic pre-gate (`source: pre-gate`), while
the two newly-covered commands (`sort -o …`, `git -C /etc status`) routed to the
classifier (`source: classifier`) — i.e. escalated rather than fast-pathed to
"safe", the fix's whole point. The classifier then allowed both (an in-cwd sort
and a read-only status are not dangerous); the fix owns the escalation, the
classifier owns the verdict.

## Worktree vs. permission rules — preserve-original, not reorder (2026-08-10)

A worktree session rewrites bash commands into `cd '<wt>' && (…)` on the
`tool_call` hook, and worktree loads before permissions, so the gate saw the
wrapped command — defeating every configured `Bash(...)` allow/ask/deny rule for
the whole session.

**Chosen: preserve-original.** worktree stashes the model's pre-wrap command on
`event.input` (`ORIGINAL_COMMAND_KEY`); only rule-matching reads it, while the
classifier and safety floor keep seeing the wrapped command (whose `cd` makes
containment resolve inside the worktree).

**Rejected: reorder permissions ahead of worktree** — the mechanism the hooks
decision used for "matchers see the model's original call"
([`hooks.md`](hooks.md)). It would have shifted worktree-session protected-path
containment from the actual write location (the worktree) back to the original
checkout, a semantic change worse than the bug (which fails toward *more*
prompting/classifier review — the safe direction).

## Background subagents now get the holistic review (2026-08-10)

Auto mode's third subagent checkpoint — reviewing a finished child's action
*sequence* as a whole ("read the deploy config, read a token, open a PR") — only
fired for foreground runs, because it attaches to the spawning call's
`tool_result`, which a background/resident run has already returned.

**Chosen: review-on-receipt.** Background turns now emit their action sequence;
the gate reviews it on receipt (shared `reviewCompletedRun`, using the last live
context) and surfaces any concern as its own follow-up notification, alongside
the completion report. The foreground path is unchanged; both share one helper.

## Next-turn reminders no longer lost without a user message (2026-08-10)

`reminderQueue.drain()` cleared the next-turn queue unconditionally, but
`injectReminders` is a no-op when there is no user message to attach to — so a
`context` event on a user-message-less array silently dropped every pending
reminder. The gate now only drains once a user message exists, honoring the
module's own documented re-enqueue contract.

## Quality cleanups, and what was deferred

~22 reuse/dedup/dead-code cleanups were applied; their rationale is the drift
they remove. Highlights: shared `lib/` helpers (`isWritingTool` hoisted to the
lower layer, `projectMemoryDir`, `restoreLatestDetails`, `perCwd`,
`safeThemePaint`, `tryReadFile`, notification-format constants); dead code
removed (workflow `AgentCallMeta`/`tokenUsage`/`ReplayCursor.totals()`, the
misleading `readCapped` size branch); two efficiency wins (MCP connect via
`Promise.allSettled`, `findRoleProfileModel` no longer double-computes
containment on the classifier hot path). A behavior fix surfaced by the review:
**`CLAUDE_CONFIG_DIR` is now honored** for CLAUDE.md/skills/commands discovery
(`claude-context`, `claude-compat`), matching real Claude Code.

**Deferred** as focused follow-ups — internal structure or low value, zero
correctness impact, high edit-risk to batch here: the `subagents/index.ts`
`execute()` split and its sibling helpers, background-worktree parallelization,
the notify-envelope consolidation across five dirs, and a few minor dedups.
