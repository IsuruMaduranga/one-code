---
name: fewer-permission-prompts
description: >
  Scan your session transcripts for common read-only Bash and MCP tool calls,
  then add a prioritized allowlist to One Code's per-repo settings to reduce
  permission prompts.
---

# Fewer Permission Prompts

Look through my transcripts' MCP and bash tool calls, and based on those, make a prioritized list of patterns that I should add to my permission allowlist to reduce permission prompts. Focus on read-only commands.

The format for permissions is: `Bash(foo*)`, `Bash(foo)`, `Bash(foo bar *)`, `mcp__slack__slack_read_thread`, etc. Claude Code's PascalCase tool names are accepted too and mapped automatically.

Then, add these to One Code's per-repo settings at `~/.one-code/projects/<slug>/settings.json` under `permissions.allow`. Never write to `~/.claude` — that is Claude Code's directory and One Code treats it as read-only.

## Steps

1. **Locate transcripts.** One Code / pi session transcripts live under the agent state dir at `~/.one-code/agent/sessions/<sanitized-cwd>/*.jsonl` (the base honours `PI_CODING_AGENT_DIR`, which the bundled app sets to `~/.one-code/agent`; a stock pi install uses its own agent dir). Each line is a JSON object. Tool calls appear as assistant messages whose content carries tool-call entries: a tool name (e.g. `Bash`, `mcp__slack__slack_read_thread`) and, for a shell tool, the command string in its input.

   Scan the recent transcripts across the sessions dir — not just the current project — so the allowlist reflects your actual usage. Cap the scan at a reasonable number of recent sessions (e.g. 50 most-recently-modified JSONL files) so this stays fast.

2. **Extract tool-call frequencies.**
   - For shell (`Bash`) calls: parse the command, take the leading command token (handling `sudo`, `timeout`, pipes, `&&`, env-var prefixes). Record the command + first subcommand pair (e.g. `git status`, `gh pr view`, `ls`, `cat`).
   - For MCP calls: record the full tool name (e.g. `mcp__slack__slack_read_thread`).
   - Count occurrences across the scanned transcripts.

3. **Filter to read-only.** Keep only commands that don't mutate state. Examples of read-only: `ls`, `cat`, `pwd`, `git status`, `git log`, `git diff`, `git show`, `git branch`, `rg`, `grep`, `find`, `head`, `tail`, `wc`, `file`, `which`, `echo`, `date`, `gh pr view`, `gh pr list`, `gh pr diff`, `gh issue view`, `gh issue list`, `gh run list`, `gh run view`, `gh api` (GET), `docker ps`, `docker logs`, `kubectl get`, `kubectl describe`, `ps`, `top`, `df`, `du`, `env`, `printenv`, any MCP tool with `read`/`get`/`list`/`search`/`view` in its name.

   Drop anything that writes, deletes, renames, pushes, merges, installs, or runs a build/test that has side effects. When in doubt, leave it out.

   **Never allowlist a pattern that grants arbitrary code execution.** A wildcard rule for any of these (e.g. `Bash(python3:*)`) is equivalent to allowing arbitrary code execution. This list is not exhaustive — apply the same rule to anything in the same category:
   - Interpreters: `python`/`python3`, `node`, `bun`, `deno`, `ruby`, `perl`, `php`, `lua`, etc.
   - Shells: `bash`, `sh`, `zsh`, `fish`, `eval`, `exec`, `ssh`, etc.
   - Package runners: `npx`, `bunx`, `uvx`, `uv run`, etc.
   - Task-runner wildcards: `npm run *`, `yarn run *`, `pnpm run *`, `bun run *`, `make *`, `just *`, `cargo run *`, `go run *`, etc. — an exact `Bash(npm run typecheck)` is fine, `Bash(npm run *)` is not
   - `gh api *`, `docker run`/`exec`, `kubectl exec`, `sudo`, and similar

4. **Drop commands One Code already auto-allows.** One Code's auto-mode floor already treats common read-only commands as safe, so they never prompt in auto mode and don't need an allowlist entry — plain `cat`, `ls`, `git status`, `grep`, and the like. If you see these in the transcripts, don't bother suggesting them. When you are unsure whether a command is already covered, it is safe to include it anyway: a redundant `permissions.allow` entry is harmless, whereas a genuinely useful allow left out keeps prompting you.

5. **Pick the pattern form.** Use the narrowest pattern that still covers the observed usage:
   - If you run many variants (`git log`, `git log --oneline`, `git log main..HEAD`): use `Bash(git log *)` — note the space before `*`, which is required for prefix matching to work correctly.
   - If a single exact invocation is common: use `Bash(foo)` with no wildcard.
   - For MCP: use the full tool name verbatim (no wildcard needed; they're already specific).
   - Never widen a pattern to the point that it conflicts with the rules above (no arbitrary code execution, no mutation/side effects).

6. **Prioritize.** Rank by count descending. Drop anything that appeared fewer than ~3 times — not worth the allowlist entry. Cap the list at the top ~20 so you can skim it.

7. **Present the prioritized list to the user** as a markdown table with columns: rank, pattern, count, one-line description. Example:

   | # | Pattern | Count | Notes |
   |---|---------|-------|-------|
   | 1 | `Bash(git status *)` | 142 | repo status checks |
   | 2 | `Bash(gh pr view *)` | 87 | PR inspection |
   | 3 | `mcp__slack__slack_read_thread` | 54 | Slack thread reads |

8. **Merge into the per-repo settings** at `~/.one-code/projects/<slug>/settings.json` (not `~/.one-code/settings.json`, not anything under `~/.claude`). Create the file if it doesn't exist. Preserve existing keys and existing entries in `permissions.allow`; de-duplicate against what's already there; don't remove anything; don't reorder unrelated fields.

9. **Report back.** Tell the user what you added (count + a few examples), what was already in the allowlist, and what you skipped and why (e.g. "dropped `rm` and `git push` — not read-only; dropped `cat`/`ls`/`git status` — already auto-allowed, no rule needed").

Do not add anything to `permissions.deny` or `permissions.ask`. Do not touch any other settings field.
