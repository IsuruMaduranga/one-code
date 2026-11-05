/**
 * enter_worktree and exit_worktree's model-facing texts: Claude Code's
 * EnterWorktree and ExitWorktree descriptions, trimmed of what One Code does
 * not have (pure).
 *
 * Removed: the WorktreeCreate/WorktreeRemove hooks, the `worktree.baseRef`
 * setting (a new worktree always branches from the current HEAD), the
 * prompt on session exit, nested repositories in a multi-repo workspace,
 * switching from an agent pinned at launch, the tmux session and the cache
 * clearing on exit. Tool names are One Code's.
 */

/** Claude Code's EnterWorktree description, naming the mode's config directory (`.onecode` in independent mode, lib/config-mode.ts). */
export function enterWorktreeDescription(configDir = ".claude"): string {
	return `Use this tool ONLY when explicitly instructed to work in a worktree — either by the user directly, or by project instructions (CLAUDE.md / memory). This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")
- CLAUDE.md or memory instructions direct you to work in a worktree for the current task

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless worktrees are explicitly requested by the user or project instructions
- Never use this tool unless "worktree" is explicitly mentioned by the user or in CLAUDE.md / memory instructions

## Requirements

- Must be in a git repository
- Must not already be in a worktree session when creating a new worktree (\`name\`); switching into another existing worktree via \`path\` is allowed

## Behavior

- In a git repository: creates a new git worktree inside \`${configDir}/worktrees/\` on a new branch from your current local HEAD
- Switches the session's working directory to the new worktree
- Use exit_worktree to leave the worktree mid-session (keep or remove)

## Entering an existing worktree

Pass \`path\` instead of \`name\` to switch the session into a worktree that already exists (e.g., one you just created with \`git worktree add\`). The path must appear in \`git worktree list\` for the current repository; other paths are rejected. exit_worktree will not remove a worktree entered this way; use \`action: "keep"\` to return to the original directory.

Switching with \`path\` also works when the session is already in a worktree (the previous worktree is left on disk, untouched). Re-issue enter_worktree with \`path\` to return to one.

## Parameters

- \`name\` (optional): A name for a new worktree. If neither \`name\` nor \`path\` is provided, a random name is generated.
- \`path\` (optional): Path to an existing worktree of the current repository to enter instead of creating one. Mutually exclusive with \`name\`.
`;
}

export const ENTER_WORKTREE_DESCRIPTION = enterWorktreeDescription();

export const EXIT_WORKTREE_DESCRIPTION = `Exit a worktree session created by enter_worktree and return the session to the original working directory.

## Scope

This tool ONLY operates on the worktree session enter_worktree started in this session. It will NOT touch:
- Worktrees you created manually with \`git worktree add\` and never entered with enter_worktree (one entered by \`path\` can be left with \`action: "keep"\`, but never removed)
- Worktrees from a previous session (even if created by enter_worktree then)
- The directory you're in if enter_worktree was never called

If called outside an enter_worktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
  - \`"keep"\` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - \`"remove"\` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to \`true\`. If the tool returns an error listing changes, confirm with the user before re-invoking with \`discard_changes: true\`.

## Behavior

- Restores the session's working directory to where it was before enter_worktree
- Once exited, enter_worktree can be called again to create a fresh worktree
`;

export const ENTER_WORKTREE_PARAMS = {
	name: `Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with \`path\`.`,
	path: `Path to an existing worktree to switch into instead of creating a new one. Must appear in \`git worktree list\` for the current repo. Mutually exclusive with \`name\`.`,
} as const;

export const EXIT_WORKTREE_PARAMS = {
	action: `"keep" leaves the worktree and branch on disk; "remove" deletes both.`,
	discard_changes: `Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.`,
} as const;
