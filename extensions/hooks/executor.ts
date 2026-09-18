/**
 * Hook command execution — the only file in extensions/hooks that touches
 * child_process. Everything upstream (matching, payload, envelope, decision)
 * is pure and tested with a fake executor; this file is tested against real
 * /bin/sh children.
 *
 * pi.exec is deliberately not used: it hardcodes shell:false and gives the
 * child no stdin, while Claude Code hooks are shell command strings that read
 * a JSON payload from stdin. (Ported from pi-code's runHookCommand, MIT — see
 * docs/decisions.md.)
 *
 * The interpreter is Claude Code's: bash (Git Bash on Windows, honouring
 * `CLAUDE_CODE_GIT_BASH_PATH`) unless the hook says `shell: "powershell"`, or
 * the machine is a Windows box without Git Bash — lib/shell-spawn.ts resolves
 * both through pi's own shell lookup.
 *
 * Hardening carried over:
 * - an absolute interpreter path, so a repo-local `sh` on PATH can't hijack
 *   the hook
 * - detached:true makes the shell a process-group leader; timeout SIGKILLs
 *   the negative pid so grandchildren holding the stdio pipes die too —
 *   otherwise `close` never fires and the promise hangs past the timeout
 *   (Windows: `taskkill /T /F` on the leader's pid does the same)
 * - setEncoding("utf8") so multi-byte characters can't be split across chunks
 * - output capped at 1MB per stream
 * - stdin errors ignored (a hook that exits without reading stdin — `exit 2`
 *   — would otherwise EPIPE-crash the write)
 * - stdin JSON is newline-terminated: without a trailing "\n" a hook doing
 *   `read -r line` sees EOF-before-delimiter and `read` exits 1, so the
 *   `if read -r line; then …` branch is silently skipped even though the
 *   variable was populated (Claude Code carries the same fix — bug CC-161)
 * - timeout clamped under Node's 2^31-1 ms timer overflow, timer unref'd (it
 *   still fires while the process lives; it must not be what keeps it alive)
 * - the child process handle stays REF'd while the hook runs, unless the caller
 *   passes `detached` (SessionEnd at shutdown, fire-and-forget). Until
 *   2026-09-05 every hook child was `unref()`d, and in a one-shot run
 *   (`pi -p` / `--mode json`) a PreToolUse hook was often the only pending
 *   work: the provider's keep-alive socket is idle between the response and
 *   the tool's spawn, so nothing ref'd remained but the hook's stdio pipes.
 *   When the child exited, the pipe-close callbacks could run before its
 *   SIGCHLD-driven exit callback; with the process handle unref'd the loop
 *   counted itself empty and node exited 0 mid-tool, silently, before the
 *   hook's `close` ever fired — measured at ~55% of runs with a trivial
 *   `exit 0` hook (docs/one-shot-lsp-event-loop-drain.md has the same
 *   mechanism for the LSP client). A ref'd child holds the loop until `close`.
 */

import type { ChildProcess } from "node:child_process";
import { detachedSpawnOptions, killProcessTree, waitForChildExit } from "../lib/process-tree.ts";
import { bashSpawn, POWERSHELL_UTF8_PREFIX, powerShellSpawn, type ShellSpawn, spawnShellCommand } from "../lib/shell-spawn.ts";
import type { HookShell } from "./settings.ts";

/**
 * Claude Code's default: hooks run in bash (Git Bash on Windows) when one
 * exists, otherwise in PowerShell — which only happens on Windows without Git
 * for Windows, since every other platform resolves a bash.
 */
export function defaultHookShell(): HookShell {
	return bashSpawn().spawn ? "bash" : "powershell";
}

/** The interpreter for one hook, or the reason none can run it. */
export function hookShellSpawn(shell: HookShell | undefined): { spec?: ShellSpawn; shell?: HookShell; error?: string } {
	const want = shell ?? defaultHookShell();
	if (want === "powershell") {
		const spec = powerShellSpawn();
		return spec ? { spec, shell: want } : { error: "hook needs PowerShell but no pwsh/powershell executable was found on PATH" };
	}
	const resolved = bashSpawn();
	if (!resolved.spawn) return { error: resolved.error ?? "hook needs bash but none was found" };
	if (resolved.spawn.commandTransport === "stdin") {
		// pi's legacy-WSL launcher takes its script on stdin, which the hook
		// payload already occupies.
		return { error: `hook cannot run under ${resolved.spawn.shell} (a WSL launcher); set CLAUDE_CODE_GIT_BASH_PATH to Git Bash's bash.exe` };
	}
	return { spec: resolved.spawn, shell: want };
}

export interface HookRunResult {
	/**
	 * null when the process was killed (timeout) or never spawned. Normalized on
	 * the timeout path rather than taken from `waitpid`: a group SIGKILL is not
	 * atomic, so the shell can be scheduled after its foreground child is killed
	 * and before its own signal lands, reap the child and exit(128+9) itself —
	 * `close` then reports a normal exit of 137 instead of death by signal
	 * (roughly 1% of timeouts under load, and never when the shell had exec'd
	 * away, leaving no shell to reap; findings §10.20). Callers should still
	 * prefer `timedOut`, which says what happened rather than what it looked
	 * like, but they no longer have to.
	 */
	exitCode: number | null;
	timedOut: boolean;
	/** Set when the child could not be spawned at all. */
	spawnError?: string;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface HookRunOptions {
	cwd: string;
	/** Seconds, Claude Code convention. Clamped to [1, MAX_TIMEOUT_S]. */
	timeoutSeconds?: number;
	/** Exposed to the hook as CLAUDE_PROJECT_DIR; defaults to cwd. */
	projectDir?: string;
	/**
	 * Let the process exit without waiting for this hook. Only for fire-and-forget
	 * dispatches at shutdown; an awaited hook must keep the event loop alive or a
	 * one-shot run drains mid-await (header). The child is `unref()`d AND spawned
	 * without stdout/stderr pipes: `unref` releases the process handle only, and
	 * each inherited pipe is a ref'd handle of its own that stays open until the
	 * child exits — a `sleep 20` SessionEnd hook held a `-p` run open for the
	 * full 20 s (LIFECYCLE-REVIEW-2026-09-06 M4, measured). stdin is still piped
	 * for the payload, written and closed at once, and unref'd too. The result's
	 * stdout/stderr are therefore empty for a detached hook — nothing reads them.
	 */
	detached?: boolean;
	/** The hook's `shell` field; unset → `defaultHookShell()`. */
	shell?: HookShell;
}

const MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_S = 60;
/** Node timers silently fire immediately above 2^31-1 ms. */
const MAX_TIMEOUT_S = 2_147_483;

export function runHookCommand(command: string, stdinJson: string, opts: HookRunOptions): Promise<HookRunResult> {
	const timeoutMs = Math.min(Math.max(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S) * 1000;
	const started = Date.now();

	return new Promise((resolve) => {
		let child: ChildProcess;
		const failed = (spawnError: string) =>
			resolve({ exitCode: null, timedOut: false, spawnError, stdout: "", stderr: "", durationMs: Date.now() - started });
		const { spec, shell, error } = hookShellSpawn(opts.shell);
		if (!spec) {
			failed(error ?? "no shell available for the hook");
			return;
		}
		// Windows PowerShell 5.1 (`powershell.exe`) defaults its console to
		// UTF-16, which would corrupt this stream once decoded as UTF-8 below
		// (setEncoding("utf8")) — the same fix every other PowerShell execution
		// path applies (lib/shell-spawn.ts, extensions/powershell/index.ts).
		const runCommand = shell === "powershell" ? `${POWERSHELL_UTF8_PREFIX}${command}` : command;
		try {
			// An absolute interpreter path (pi's resolver never yields a bare name
			// where a real bash exists), so a repo-local `sh` on PATH cannot hijack
			// the hook; the shell leads its own process group so a timeout kills
			// grandchildren too (Windows: taskkill /T — lib/process-tree.ts).
			child = spawnShellCommand(spec, runCommand, {
				cwd: opts.cwd,
				...detachedSpawnOptions(),
				// A fire-and-forget hook must outlive a parent that is exiting; on
				// Windows that is what `detached: true` is for (Node's documented
				// meaning there), and the leader is still killed by pid.
				...(opts.detached && process.platform === "win32" ? { detached: true } : {}),
				stdio: opts.detached ? ["pipe", "ignore", "ignore"] : ["pipe", "pipe", "pipe"],
				env: { ...process.env, CLAUDE_PROJECT_DIR: opts.projectDir ?? opts.cwd },
			});
		} catch (error) {
			resolve({
				exitCode: null,
				timedOut: false,
				spawnError: error instanceof Error ? error.message : String(error),
				stdout: "",
				stderr: "",
				durationMs: Date.now() - started,
			});
			return;
		}
		if (opts.detached) {
			child.unref();
			// The stdin pipe is the one handle left; it closes as soon as the
			// payload is flushed below, and must not hold the loop meanwhile.
			(child.stdin as { unref?: () => void } | null)?.unref?.();
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const capture = (sink: "stdout" | "stderr") => (chunk: string) => {
			const current = sink === "stdout" ? stdout : stderr;
			if (current.length >= MAX_OUTPUT_BYTES) return;
			const next = current + chunk.slice(0, MAX_OUTPUT_BYTES - current.length);
			if (sink === "stdout") stdout = next;
			else stderr = next;
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", capture("stdout"));
		child.stderr?.on("data", capture("stderr"));

		const timer = setTimeout(() => {
			timedOut = true;
			// The whole process group the detached shell leads (lib/process-tree.ts).
			killProcessTree(child, "SIGKILL");
		}, timeoutMs);
		timer.unref();

		const finish = (result: Omit<HookRunResult, "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ...result, durationMs: Date.now() - started });
		};

		// Settles on exit plus a short stdio grace, not on `close`: a grandchild
		// the kill missed could otherwise hold the pipes — and this promise — open
		// for its whole life (lib/process-tree.ts). A killed process reports null,
		// EXCEPT when the shell outlived the group kill just long enough to reap
		// its child and exit 128+9 itself (see exitCode's contract). Normalizing
		// keeps "we killed it" from ever looking like an ordinary non-zero exit,
		// which fails OPEN downstream.
		waitForChildExit(child).then(
			({ code }) => finish({ exitCode: timedOut ? null : code, timedOut, stdout, stderr }),
			(error: Error) => finish({ exitCode: null, timedOut, spawnError: error.message, stdout, stderr }),
		);

		// A hook that never reads stdin (e.g. plain `exit 2`) closes the pipe
		// early; the resulting EPIPE must not take the extension down.
		child.stdin?.on("error", () => {});
		child.stdin?.write(stdinJson.endsWith("\n") ? stdinJson : `${stdinJson}\n`);
		child.stdin?.end();
	});
}
