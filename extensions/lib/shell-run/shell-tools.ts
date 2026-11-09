/**
 * The tools whose subject is a shell command line (pure, no pi imports): the
 * one list the permission matcher (`isShellTool`), the classifier transcript
 * (`{"Bash":…}` / `{"PowerShell":…}` rendering) and the worktree rewriter
 * read, so adding a shell tool is one edit.
 */

export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** Whether an already-normalized (pi snake_case) tool name is a shell tool. */
export function isShellToolName(normalizedName: string): boolean {
	return SHELL_TOOLS.has(normalizedName);
}
