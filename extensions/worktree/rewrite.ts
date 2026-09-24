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

/** PowerShell single-quoted literal: only `'` needs escaping, as `''`. */
export function powershellQuote(path: string): string {
	return `'${path.replace(/'/g, "''")}'`;
}


/**
 * Mutates `input` in place so the call runs inside the worktree. For bash,
 * returns the model's ORIGINAL command (pre-`cd`-wrapper) so the caller can
 * publish it over `ORIGINAL_COMMAND_CHANNEL` keyed by the call id: the
 * permission matcher evaluates rules against what the model asked for, not
 * the wrapper (which starts with `cd` and matches no Bash rule), while the
 * classifier and safety floor keep reading the wrapped `input.command`, whose
 * `cd` makes containment resolve inside the worktree —
 * working-docs/decisions/code-review-remediation.md ("Worktree vs. permission rules").
 * The original is deliberately NOT stored in `input`: a key there is
 * model-writable (lib/original-command.ts).
 */
export function rewriteToolInput(
	toolName: string,
	input: Record<string, unknown>,
	worktreePath: string,
): { originalCommand?: string } {
	if (toolName === "bash") {
		if (typeof input.command === "string") {
			const originalCommand = input.command;
			input.command = `cd ${shellQuote(worktreePath)} && (${originalCommand}\n)`;
			return { originalCommand };
		}
		return {};
	}
	if (toolName === "powershell") {
		// `Set-Location -LiteralPath` takes the path verbatim (no wildcard
		// expansion); `;` chains regardless of edition (`&&` is pwsh-7-only), and a
		// failed Set-Location is a terminating error under -NonInteractive, so the
		// command does not run in the wrong directory.
		if (typeof input.command === "string") {
			const originalCommand = input.command;
			input.command = `Set-Location -LiteralPath ${powershellQuote(worktreePath)} -ErrorAction Stop; ${originalCommand}`;
			return { originalCommand };
		}
		return {};
	}
	if (!PATH_TOOLS.has(toolName)) return {};

	// Rewrite whichever field carries the path — `path` for pi's built-ins,
	// `file_path`/`notebook_path` for Claude Code-shaped calls — so a
	// notebook_edit using `notebook_path` still lands inside the worktree
	// instead of the shared checkout (code-review).
	const pathField = (["path", "file_path", "notebook_path"] as const).find(
		(field) => typeof input[field] === "string" && (input[field] as string).length > 0,
	);
	if (pathField) {
		const value = input[pathField] as string;
		if (!isAbsolute(value)) input[pathField] = resolve(worktreePath, value);
	} else if (DEFAULTS_TO_CWD.has(toolName)) {
		input.path = worktreePath;
	}
	return {};
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
