/**
 * Process-tree termination for the shells One Code spawns in the background
 * (`bash run_in_background`, `monitor`).
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
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/** SIGTERM → SIGKILL grace for a stopped background tree (bash tasks, monitors). */
export const KILL_GRACE_MS = 2_000;

/** `detached` everywhere but Windows, where process groups do not exist. */
export function detachedSpawnOptions(): { detached: boolean } {
	return { detached: process.platform !== "win32" };
}

/**
 * Windows has no process groups and no SIGTERM: `taskkill /T /F` ends the
 * tree by pid (the same call pi's own `killProcessTree` makes), from System32
 * so a PATH entry cannot substitute the binary. A failed spawn is consumed —
 * the leader may already be gone.
 */
function taskkillTree(pid: number): void {
	try {
		const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.once("error", () => {});
		child.unref();
	} catch {
		// Already gone.
	}
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	if (child.pid == null) return;
	if (process.platform === "win32") {
		taskkillTree(child.pid);
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
