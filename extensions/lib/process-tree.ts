/**
 * Process-tree termination for the shells One Code spawns in the background
 * (`bash run_in_background`, `monitor`), and the one way to wait for such a
 * child to finish.
 *
 * A `$SHELL -c "cmd"` child is only the leader: with zsh (macOS default) a
 * `cmd; echo` or a pipeline runs the command in further processes, and
 * `child.kill()` signals the shell alone — the command lives on as an orphan
 * holding the inherited stdout pipe, so `close` never fires (the task cannot
 * finish, a `task_output block:true` waits its full timeout) and in a one-shot
 * run the open pipe keeps node alive until the orphan exits
 * (LIFECYCLE-REVIEW-2026-09-06 M2, measured: 3 min 21 s on a `tail -f | cat`).
 *
 * The producer spawns `detached` (own process group; `detachedSpawnOptions`)
 * and stops it with `killProcessTree`, which signals the negative pid — the
 * whole group — falling back to the child alone when the group is already gone.
 * `stopProcessTree` adds the grace period: SIGTERM now, SIGKILL if the leader
 * has not exited by then (a command that ignores SIGTERM still closes late,
 * which is exactly the late callback the shutdown paths guard against).
 *
 * `waitForChildExit` is the counterpart on the waiting side: it settles on
 * `exit` plus a short stdio grace, never on `close` alone — a descendant the
 * kill missed (Windows: a process the `taskkill /T` snapshot did not see) can
 * hold the inherited pipes open for as long as it lives, and the task must not
 * wait for it (pi's `waitForChildProcess` has the same shape and reason).
 */

import { type ChildProcess, execFile } from "node:child_process";
import { system32Path } from "./paths.ts";

/** SIGTERM → SIGKILL grace for a stopped background tree (bash tasks, monitors). */
export const KILL_GRACE_MS = 2_000;

/** After `exit`, how long buffered stdio may keep arriving before the wait settles. */
export const EXIT_STDIO_GRACE_MS = 200;

/** ...and the most it may keep arriving in total: a straggler writing continuously must not keep re-arming the grace. */
export const EXIT_STDIO_MAX_MS = 2_000;

/**
 * `detached` everywhere but Windows, where process groups do not exist — except
 * for a child that must outlive an exiting parent (a fire-and-forget hook),
 * which is what `detached: true` means on Windows (Node's documented use); the
 * leader is still killed by pid there.
 */
export function detachedSpawnOptions(opts: { outlivesParent?: boolean } = {}): { detached: boolean } {
	return { detached: process.platform !== "win32" || Boolean(opts.outlivesParent) };
}

/**
 * Windows has no process groups and no SIGTERM: `taskkill /T /F` ends the
 * tree by pid (the same call pi's own `killProcessTree` makes), from System32
 * so a PATH entry cannot substitute the binary. Whatever taskkill reports, the
 * leader itself is then terminated directly too — taskkill can fail to kill
 * (or to find) a member, and the leader's exit is what the waiting side keys
 * on. `ONECODE_DEBUG_KILL=1` logs taskkill's output to stderr.
 */
function taskkillTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid == null) return;
	const direct = () => {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	};
	try {
		const proc = execFile(system32Path("taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, (error, stdout, stderr) => {
			if (process.env.ONECODE_DEBUG_KILL) {
				process.stderr.write(`[process-tree] taskkill /T /F /PID ${pid}: ${error ? `error ${error.message}` : "ok"}\n${stdout}${stderr}`);
			}
			direct();
		});
		proc.unref();
	} catch {
		direct();
	}
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	if (child.pid == null) return;
	if (process.platform === "win32") {
		taskkillTree(child);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

/**
 * SIGTERM the tree, then SIGKILL it after `graceMs` unless the leader exited.
 * The timer is unref'd: it must never be what keeps a one-shot process alive.
 */
export function stopProcessTree(child: ChildProcess, graceMs: number): void {
	killProcessTree(child, "SIGTERM");
	// taskkill /F is already forceful; there is no gentler first signal to grace.
	if (process.platform === "win32") return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	const timer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) killProcessTree(child, "SIGKILL");
	}, graceMs);
	timer.unref?.();
	child.once("exit", () => clearTimeout(timer));
}

export interface ChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * Resolve when the child has exited and its stdio has drained: on `close`
 * when that arrives promptly, else `EXIT_STDIO_GRACE_MS` after `exit` (the
 * grace re-arms while output is still arriving, so a burst written just before
 * exit is not cut) and `EXIT_STDIO_MAX_MS` after `exit` at the latest (a
 * descendant the kill missed that keeps writing must not hold the wait).
 * Rejects on a spawn `error`. Listeners the caller attached for `data` keep
 * working; the streams are destroyed once this settles so a straggler holding
 * the far end cannot keep them — or the process — alive.
 */
export function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited: ChildExit | undefined;
		let grace: NodeJS.Timeout | undefined;
		let deadline: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (grace) clearTimeout(grace);
			if (deadline) clearTimeout(deadline);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finish = () => {
			if (settled || !exited) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(exited);
		};
		const arm = () => {
			if (grace) clearTimeout(grace);
			// Ref'd on purpose: in a one-shot run this timer may be the only handle
			// left once the pipes have closed, and the promise must still settle.
			grace = setTimeout(finish, EXIT_STDIO_GRACE_MS);
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			exited = { code, signal };
			arm();
			deadline = setTimeout(finish, EXIT_STDIO_MAX_MS);
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			exited ??= { code, signal };
			finish();
		};
		const onData = () => {
			if (exited && !settled) arm();
		};
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
	});
}
