/**
 * Open a memory file or folder in the user's editor / OS opener, matching Claude
 * Code's `/memory`: a file goes to `$VISUAL`/`$EDITOR` (or the OS default), a
 * folder to the OS file manager. The child is detached and unref'd so the TUI is
 * never blocked (as the MCP OAuth browser open does). Returns the status line and
 * the editor hint to print, matching CC's "Opened <path>" + the $EDITOR nudge.
 *
 * A terminal editor (vim/nano) needs the tty and cannot run detached; this suits
 * GUI editors (code, subl) and the OS opener, which is CC's common desktop case.
 * The choice of editor command is otherwise pure and unit-tested via `resolveOpen`.
 */

import { spawn } from "node:child_process";

export interface OpenPlan {
	command: string;
	args: string[];
}

/** Pure: decide the command + args to open `path`. `plat` defaults to the host platform. */
export function resolveOpen(
	path: string,
	kind: "file" | "folder",
	env: Record<string, string | undefined> = process.env,
	plat: NodeJS.Platform = process.platform,
): OpenPlan {
	const editor = kind === "file" ? (env.VISUAL || env.EDITOR)?.trim() : undefined;
	if (editor) {
		// An editor setting may carry flags ("code -w"); keep them before the path.
		const parts = editor.split(/\s+/);
		return { command: parts[0], args: [...parts.slice(1), path] };
	}
	if (plat === "darwin") return { command: "open", args: [path] };
	if (plat === "win32") return { command: "cmd", args: ["/c", "start", "", path] };
	return { command: "xdg-open", args: [path] };
}

export interface OpenResult {
	message: string;
	hint?: string;
	ok: boolean;
}

/** The editor hint CC prints under an opened file. */
export const EDITOR_HINT = "To use a different editor, set the $EDITOR or $VISUAL environment variable.";

export function openPath(path: string, kind: "file" | "folder"): OpenResult {
	const { command, args } = resolveOpen(path, kind);
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.unref();
	} catch (error) {
		return { message: `Could not open ${path}: ${error instanceof Error ? error.message : error}`, ok: false };
	}
	return {
		message: `Opened ${path}`,
		// CC shows the hint on file opens (even when $EDITOR handled it); folders don't.
		hint: kind === "file" ? EDITOR_HINT : undefined,
		ok: true,
	};
}
