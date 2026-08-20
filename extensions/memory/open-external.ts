/**
 * Open a memory file or folder in the user's editor / OS opener, matching Claude
 * Code's `/memory`: a file goes to `$VISUAL`/`$EDITOR` (or the OS default), a
 * folder to the OS file manager. The child is detached and unref'd so the TUI is
 * never blocked (as the MCP OAuth browser open does). Returns the status line and
 * the editor hint to print, matching CC's "Opened <path>" + the $EDITOR nudge.
 *
 * Limitation: a terminal editor (vim/nano) needs the controlling tty, which the
 * pi TUI owns, so it cannot run detached — this suits GUI editors (code, subl)
 * and the OS opener, CC's common desktop case. We can detect a failed *spawn*
 * (an unknown editor command) but not a GUI editor that opens a not-yet-created
 * file (it materialises on save) — so `openPath` reports success once the child
 * spawns. The command choice is pure and unit-tested via `resolveOpen`.
 */

import { spawn } from "node:child_process";

export interface OpenPlan {
	command: string;
	args: string[];
}

/**
 * Split an `$EDITOR`/`$VISUAL` value into command + flags, honouring single and
 * double quotes so a spaced editor path works when quoted (`"/Apps/My Editor" -w`)
 * — the same contract as a shell, and what tools like git expect. An unquoted
 * space is a token boundary, so a spaced path must be quoted (as elsewhere).
 */
function tokenizeEditor(editor: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(editor)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
	return tokens;
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
		const parts = tokenizeEditor(editor);
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

/**
 * Spawn the opener/editor detached, resolving once the child either spawns
 * (success) or fails to spawn (e.g. an unknown `$EDITOR` command — reported as an
 * error instead of a false "Opened"). Both spawn outcomes always fire exactly one
 * of these events, so the promise never hangs.
 */
export function openPath(path: string, kind: "file" | "folder"): Promise<OpenResult> {
	const { command, args } = resolveOpen(path, kind);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: OpenResult) => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: "ignore", detached: true });
		} catch (error) {
			finish({ message: `Could not open ${path}: ${error instanceof Error ? error.message : error}`, ok: false });
			return;
		}
		child.on("error", (error) => finish({ message: `Could not open ${path}: ${error.message}`, ok: false }));
		child.on("spawn", () => {
			child.unref();
			finish({
				message: `Opened ${path}`,
				// CC shows the hint on file opens (even when $EDITOR handled it); folders don't.
				hint: kind === "file" ? EDITOR_HINT : undefined,
				ok: true,
			});
		});
	});
}
