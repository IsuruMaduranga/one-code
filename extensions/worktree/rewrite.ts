/**
 * Worktree-session input rewriting (pure).
 *
 * pi binds every built-in tool to the cwd captured at session creation, so a
 * live session cannot truly change directory. While a worktree session is
 * active we instead rewrite tool inputs on the tool_call hook: bash commands
 * get a `cd` prefix, and relative paths resolve against the worktree. Absolute
 * paths are left alone — pointing back at the original checkout stays possible
 * and explicit.
 */

import { isAbsolute, resolve } from "node:path";

/** Tools whose `path` argument is relative to the session cwd. */
const PATH_TOOLS = new Set(["read", "edit", "write", "notebook_edit", "grep", "find", "ls", "lsp_diagnostics"]);
/** Of those, the ones where a missing path means "the cwd itself". */
const DEFAULTS_TO_CWD = new Set(["grep", "find", "ls"]);

export function shellQuote(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Mutates `input` in place so the call runs inside the worktree. */
export function rewriteToolInput(toolName: string, input: Record<string, unknown>, worktreePath: string): void {
	if (toolName === "bash") {
		if (typeof input.command === "string") {
			input.command = `cd ${shellQuote(worktreePath)} && (${input.command}\n)`;
		}
		return;
	}
	if (!PATH_TOOLS.has(toolName)) return;

	if (typeof input.path === "string" && input.path.length > 0) {
		if (!isAbsolute(input.path)) input.path = resolve(worktreePath, input.path);
	} else if (DEFAULTS_TO_CWD.has(toolName)) {
		input.path = worktreePath;
	}
}

/** Validates an EnterWorktree name: /-separated segments of [A-Za-z0-9._-], ≤64 chars total. */
export function validateWorktreeName(name: string): string | undefined {
	if (name.length === 0 || name.length > 64) return "name must be 1-64 characters";
	if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name)) {
		return "each /-separated segment may contain only letters, digits, dots, underscores, and dashes";
	}
	if (name.split("/").some((seg) => seg === "." || seg === "..")) return "segments may not be . or ..";
	return undefined;
}
