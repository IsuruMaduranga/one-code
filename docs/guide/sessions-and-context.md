# Sessions and context

[← One Code user guide](README.md)

This page covers what One Code puts into the model's context, how it keeps
long sessions within the context window, what it remembers between
sessions, and how to continue or branch a session.

## What the model sees at the start

The first message of every session carries a context block built the same
way Claude Code builds it, so the model reads your instructions exactly as
it would there. The block contains, in order:

1. **Project instructions.** Every `CLAUDE.md` from your home directory's
   `~/.claude/CLAUDE.md` down through each ancestor directory to the
   working directory. In a directory that has no `CLAUDE.md`, an
   `AGENTS.md` is used instead. A `CLAUDE.local.md` next to either is
   included as your private, uncommitted instructions.
2. **The auto-memory index.** The first 200 lines or 25 KB of `MEMORY.md`
   from the repository's memory folder. See [Memory](#memory).
3. **Your email**, from `git config user.email` (or `GIT_AUTHOR_EMAIL` or
   `EMAIL`), for attribution.
4. **Today's date.**

`@path` references inside a `CLAUDE.md` are expanded in place, up to five
levels deep, so a file that imports shared instructions keeps working.
Paths resolve relative to the importing file; `~/` resolves to your home
directory. References inside code spans and fenced blocks are left alone.

A `CLAUDE.md` larger than 40,000 characters, or a set of instruction files
whose total exceeds that, triggers a warning at startup so you can trim it.
Run `/memory` to open any of these files.

### ONECODE.md

Instructions that only One Code should read go in `ONECODE.md`
(`onecode.md` and `One Code.md` also work). Claude Code never reads this
file. One Code adds it as a separate block after the Claude Code context,
marked as taking precedence, so the order is ONECODE.md, then CLAUDE.md,
then AGENTS.md. A global `~/.onecode/ONECODE.md` is read too.

Use it for instructions that mention One Code features, such as the
`ultracode` keyword or a subagent model preference, without confusing a
real Claude Code session on the same repository.

### The system prompt

The system prompt is an adaptation of Claude Code's, chosen by the
capability of the model in use. Stronger models receive a terse prompt;
smaller models receive more guidance and, on the smallest tier, extra
search tools. It ends with a git status snapshot (branch, main branch, user,
working-tree status, recent commits) taken once per session. See
[Prompting adapts to the model](providers-and-models.md#prompting-adapts-to-the-model).

## Memory

One Code keeps per-repository memory in the same place Claude Code does:
`~/.claude/projects/<slug>/memory/`, where the slug is derived from the
repository root (or the working directory outside a repository). Worktrees
and subdirectories of one repository share one memory folder. This is the
one place One Code writes under `~/.claude`, so a real Claude Code session
on the same repository reads the same memories.

The model writes one file per memory and keeps an index in `MEMORY.md`.
When the index grows near its limit (200 lines or 25 KB), the model is
warned; past the limit, a write to it still succeeds but returns an error
so the model trims the index.

Run `/memory` to open the memory folder or any instruction file. Files open
in `$VISUAL` or `$EDITOR`; folders open in your file manager.

## The context window

### Compaction

When the conversation approaches the context limit, One Code replaces the
older part with a summary, using Claude Code's compaction instruction: the
summary keeps the request and intent, key concepts, the files touched,
errors and fixes, every user message, pending tasks, and the current work.
The summary also points the model at the session file so it can search the
full transcript if it needs a detail.

Run `/compact` to compact at any time; you can pass instructions about what
the summary should focus on. Compaction that happens because the context is
full is more expensive than a manual or threshold compaction, because it
can't reuse the cached prefix of the conversation.

Set `CC_COMPACTION=0` to use pi's own summary instead.

### The token budget line

Like Claude Code, One Code tells the model how many tokens it has left in
the current turn: a `<total_tokens>` line appears in the system prompt, at
the end of every user message, and after every tool result. The budget is
15,000,000 tokens per turn, Claude Code's own figure. Set
`CC_TOTAL_TOKENS_BUDGET` to change it or `CC_TOTAL_TOKENS=0` to remove it.

### Thinking blocks and the cache

On Anthropic's own API, One Code asks the provider to keep earlier thinking
blocks in place rather than strip them, because stripping them invalidates
the prompt cache on older models. This is on by default for
`api.anthropic.com` and off for Bedrock, Vertex, and proxies. Set
`CC_CLEAR_THINKING=1` to force it on elsewhere or `CC_CLEAR_THINKING=0` to
turn it off.

### The prompt cache

Interactive sessions ask the provider for an extended cache lifetime (one
hour on Anthropic; provider-dependent elsewhere), so a pause between turns
doesn't re-send the whole conversation. Subagents, workflow agents, and
`-p` or `--mode json` runs use the provider's short default. Set
`PI_CACHE_RETENTION` yourself to take over the choice. The footer shows the
cache-hit rate of the latest turn.

Changing the reasoning effort or the model re-caches the conversation, so
one request after such a change costs more than usual.

## Scratch space and large output

Each session gets a scratchpad directory under the system temp directory,
named by project and session. The model is told to use it for temporary
files instead of `/tmp`; writes there need no approval.

Tool output larger than 50 KB isn't truncated. It's written to a file
under the session directory, and the model receives the path, the size,
and a 2 KB preview in a `<persisted-output>` block, so it can read the part
it needs.

## While you are away

After five minutes without a keystroke following a turn, One Code shows a
short recap of what the model was doing and what comes next, prefixed with
`※ recap:`. The recap is produced by a cheap model on your provider using
Claude Code's own recap prompt, is display-only, and is never sent back to
the model. Its cost is included in the footer's total.

Set `CC_RECAP_IDLE_MS` to change the delay (in milliseconds) or `CC_RECAP=0`
to turn recaps off.

## Continue, resume, and branch

Session management is pi's own. The commands work the same under `onecode`:

```bash
onecode -c                    # continue the most recent session
onecode -r                    # browse and pick a session to resume
onecode --session <id>        # open a specific session
onecode --fork <id>           # fork a session into a new file
onecode --no-session          # do not save this session
```

Inside a session, `/resume` browses sessions, `/tree` shows the session's
branches and lets you switch between them, `/fork` and `/clone` copy the
session, `/name` names it, and `/export` writes it to HTML.

The resume hint printed when a session ends reads `onecode --session …`
under the bundled app.

### What comes back after a resume or branch switch

Restored from the session file:

- The file-tracker's record of which files the model has read, checked
  against the current contents on disk.
- The structured task list.
- The plan file, when the session was in plan mode.
- The history of subagent runs, so a finished subagent can still be
  messaged.

Not restored:

- The permission mode. A resumed session starts in the configured default.
- Background shells, monitors, running subagents, and background workflow
  runs. They stop when a session ends; the next session is told what was
  stopped. A workflow can be resumed from its journal.
- Session-only approvals from the permission prompt.
- The reasoning effort level.

### Start over

`/clear` starts a new session in the same directory, the same as pi's
`/new`. Running background tasks are stopped and listed. The permission
mode you chose carries over.

### What the model learns about your commands

As in Claude Code, a slash command you run is recorded for the model: the
next message you send carries a short note that the command ran, wrapped in a
caveat telling the model not to act on it. `/clear` opens the new session
with that note, and a model switch records "Set model to …" the way Claude
Code does. Commands that One Code cannot observe (pi's own `/compact`,
`/settings`, `/name`) leave no note.

### The session title

After your first real message, One Code names the session the way Claude
Code does: a cheap model on your provider turns the message into a short
title (Claude Code's own naming prompt), which shows in the terminal tab as
`One Code - <title> - <folder>` and in the session picker. A name you set
with `/name` is never overwritten. The call's cost is included in the
footer's total. Set `CC_SESSION_TITLE=0` to turn it off.

## Turn timing

After each turn, a dim line such as `✻ Cooked for 5m 12s` reports how long
it took, with a random verb, as in Claude Code. When background shells are
still running, the line adds a count. Set `CC_TURN_DURATION=0` to turn it
off.
