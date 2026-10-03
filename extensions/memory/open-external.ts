/**
 * Open a memory file or folder in the user's editor / OS opener, matching Claude
 * Code's `/memory`: a file goes to `$VISUAL`/`$EDITOR` (or the OS default), a
 * folder to the OS file manager. The child is detached and unref'd so the TUI is
 * never blocked (as the MCP OAuth browser open does). The caller words the
 * result (`memoryDisplayPath`, `editorHint`), matching CC's `/memory`.
 *
 * Limitation: a terminal editor (vim/nano) needs the controlling tty, which the
 * pi TUI owns, so it cannot run detached — this suits GUI editors (code, subl)
 * and the OS opener, CC's common desktop case. We can detect a failed *spawn*
 * (an unknown editor command) but not a GUI editor that opens a not-yet-created
 * file (it materialises on save) — so `openPath` reports success once the child
 * spawns. The command choice is pure and unit-tested via `resolveOpen`.
 */

import { spawn } from "node:child_process";
import { relative } from "node:path";
import { childProcessEnv } from "../lib/app-launch.mjs";
import { commandLaunch } from "../lib/command-launch.ts";
import { forwardSlashes, isRelativeInside, tildify } from "../lib/paths.ts";

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

export type OpenResult = { ok: true } | { ok: false; error: string };

/**
 * CC's display path for `/memory`'s result: `~/…` under the home directory,
 * `./…` under the working directory, the shorter when both apply, else as is.
 */
export function memoryDisplayPath(path: string, cwd: string, home: string): string {
	const tilde = tildify(path, home);
	const underHome = tilde !== path;
	const rel = relative(cwd, path);
	const dot = isRelativeInside(rel) ? `./${forwardSlashes(rel)}` : undefined;
	if (underHome && dot) return tilde.length <= dot.length ? tilde : dot;
	return underHome ? tilde : (dot ?? path);
}

/** CC's editor hint under an opened file, naming the variable it used. */
export function editorHint(env: Record<string, string | undefined> = process.env): string {
	const used = env.VISUAL ? `Using $VISUAL="${env.VISUAL}".` : env.EDITOR ? `Using $EDITOR="${env.EDITOR}".` : "";
	return used
		? `> ${used} To change editor, set $EDITOR or $VISUAL environment variable.`
		: "> To use a different editor, set the $EDITOR or $VISUAL environment variable.";
}

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
			// `$EDITOR=code` is VS Code's `code.cmd` shim on Windows, which a bare spawn cannot start.
			// The user's own environment under the bundled app (lib/app-launch.mjs): an
			// editor with a terminal must not hand the app's pi state to a `pi` run there.
			const env = childProcessEnv(process.env);
			const launch = commandLaunch(command, args, env);
			child = spawn(launch.command, launch.args, { env, stdio: "ignore", detached: true, windowsVerbatimArguments: launch.windowsVerbatimArguments });
		} catch (error) {
			finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("spawn", () => {
			child.unref();
			finish({ ok: true });
		});
	});
}
