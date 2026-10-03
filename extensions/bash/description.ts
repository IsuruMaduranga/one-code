/**
 * The bash tool's model-facing texts: Claude Code's Bash descriptions (pure).
 *
 * Claude Code has three: a short form for its current models, with one extra
 * bullet ("IMPORTANT: Avoid using this tool to run `cat`…") when auto mode is
 * off, and a long form for its weakest models that is the same in every mode.
 * One Code picks the form by tier (lib/tool-variants.ts) and the extra bullet
 * by the permission mode. Two kinds of change from Claude Code's text: tool
 * names are One Code's (`read`, `edit`, `write`, `monitor`, `task_create`),
 * and the working-directory sentence says what this tool does, since each
 * command starts in the session's working directory and a `cd` does not carry
 * over (lib/shell-tool.ts), where Claude Code tracks the directory between
 * calls. The parameter texts are Claude Code's.
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";

/** The bullet Claude Code adds to the short form when auto mode is off. */
export const BASH_AVOID_SHELL_READS_LINE = "- IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\n";

/** The short form outside auto mode. */
export const BASH_SHORT_DESCRIPTION = `Executes a bash command and returns its output.

- Each call starts in the session's working directory and a \`cd\` does not carry over, so prefer absolute paths — \`cd\` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist.
- IMPORTANT: Avoid using this tool to run \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.
- Command output is displayed to you, not reliably to the user.
- \`timeout\` is in milliseconds: default 120000, max 600000 for a foreground command.
- \`run_in_background\` runs the command detached: it keeps running across turns and re-invokes you when it exits. No \`&\` needed. Foreground \`sleep\` is blocked; use monitor with an until-loop to wait on a condition.

# Git
- Interactive flags (\`-i\`, e.g. \`git rebase -i\`, \`git add -i\`) are not supported in this environment.
- Use the \`gh\` CLI for GitHub operations (PRs, issues, API).
- Commit or push only when the user asks. If on the default branch, branch first.
- End git commit messages and PR bodies with the attribution lines given in the conversation's system-reminder, when one is present.`;

/** The long form (every permission mode). */
export const BASH_LONG_DESCRIPTION = `Executes a given bash command and returns its output.

Each command starts in the session's working directory; neither a directory change (\`cd\`) nor shell state (variables, functions) carries over to the next command.

IMPORTANT: Avoid using this tool to run \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - Read files: Use read (NOT cat/head/tail)
 - Edit files: Use edit (NOT sed/awk)
 - Write files: Use write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
While the bash tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it. In particular, never prepend \`cd <current-directory>\` to a \`git\` command — \`git\` already operates on the current working tree, and the compound triggers a permission prompt.
 - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes for a foreground command). By default, your command will timeout after 120000ms (2 minutes).
 - You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary \`sleep\` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - Use the monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use bash with run_in_background instead.
  - If your command is long running and you would like to be notified when it finishes — use \`run_in_background\`. No sleep needed.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll.
  - Long leading \`sleep\` commands are blocked. To poll until a condition is met, use monitor with an until-loop (e.g. \`until <check>; do sleep 2; done\`) — you get a notification when the loop exits. Do not chain shorter sleeps to work around the block.
 - When running \`find\`, search from \`.\` (or a specific path), not \`/\` — scanning the full filesystem can exhaust system resources on large trees.
 - When using \`find -regex\` with alternation, put the longest alternative first. Example: use \`'.*\\.\\(tsx\\|ts\\)'\` not \`'.*\\.\\(ts\\|tsx\\)'\` — the second form silently skips \`.tsx\` files.


# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following bash commands in parallel, each using the bash tool:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands in parallel:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message, ending with the attribution lines given in the conversation's system-reminder, when one is present.
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git bash commands
- NEVER use the task_create or Agent tools
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.
   EOF
   )"
</example>

# Creating pull requests
Use the gh command via the bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following bash commands in parallel using the bash tool, in order to understand the current state of the branch since it diverged from the main branch:
   - Run a git status command to see all untracked files (never use -uall flag)
   - Run a git diff command to see both staged and unstaged changes that will be committed
   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote
   - Run a git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting. End the body with the attribution lines given in the conversation's system-reminder, when one is present.
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]
EOF
)"
</example>

Important:
- DO NOT use the task_create or Agent tools
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`;

/** The description for a form and permission mode. */
export function bashDescription(form: DescriptionForm, autoMode: boolean): string {
	if (form === "long") return BASH_LONG_DESCRIPTION;
	return autoMode ? BASH_SHORT_DESCRIPTION.replace(BASH_AVOID_SHELL_READS_LINE, "") : BASH_SHORT_DESCRIPTION;
}

/** Claude Code's parameter descriptions. */
export const BASH_PARAMS = {
	command: `The command to execute`,
	timeout: `Optional timeout in milliseconds (max 600000 for a foreground command)`,
	description: `Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

Say what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`,
	run_in_background: `Set to true to run this command in the background.`,
} as const;
