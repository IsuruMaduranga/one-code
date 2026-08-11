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
 * Hardening carried over:
 * - absolute /bin/sh, so a repo-local `sh` on PATH can't hijack the hook
 * - detached:true makes the shell a process-group leader; timeout SIGKILLs
 *   the negative pid so grandchildren holding the stdio pipes die too —
 *   otherwise `close` never fires and the promise hangs past the timeout
 * - setEncoding("utf8") so multi-byte characters can't be split across chunks
 * - output capped at 1MB per stream
 * - stdin errors ignored (a hook that exits without reading stdin — `exit 2`
 *   — would otherwise EPIPE-crash the write)
 * - stdin JSON is newline-terminated: without a trailing "\n" a hook doing
 *   `read -r line` sees EOF-before-delimiter and `read` exits 1, so the
 *   `if read -r line; then …` branch is silently skipped even though the
 *   variable was populated (Claude Code carries the same fix — bug CC-161)
 * - timeout clamped under Node's 2^31-1 ms timer overflow, timer unref'd so a
 *   pending hook can't keep a one-shot `pi -p` process alive
 */

import { spawn } from "node:child_process";

export interface HookRunResult {
	/** null when the process was killed (timeout) or never spawned. */
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
}

const MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_S = 60;
/** Node timers silently fire immediately above 2^31-1 ms. */
const MAX_TIMEOUT_S = 2_147_483;

export function runHookCommand(command: string, stdinJson: string, opts: HookRunOptions): Promise<HookRunResult> {
	const timeoutMs = Math.min(Math.max(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S) * 1000;
	const started = Date.now();

	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("/bin/sh", ["-c", command], {
				cwd: opts.cwd,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
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
		child.unref();

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

		const killTree = () => {
			// Negative pid = the whole process group the detached shell leads.
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutMs);
		timer.unref();

		const finish = (result: Omit<HookRunResult, "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ...result, durationMs: Date.now() - started });
		};

		child.on("error", (error) => {
			finish({ exitCode: null, timedOut, spawnError: error.message, stdout, stderr });
		});
		child.on("close", (code) => {
			finish({ exitCode: code, timedOut, stdout, stderr });
		});

		// A hook that never reads stdin (e.g. plain `exit 2`) closes the pipe
		// early; the resulting EPIPE must not take the extension down.
		child.stdin?.on("error", () => {});
		child.stdin?.write(stdinJson.endsWith("\n") ? stdinJson : `${stdinJson}\n`);
		child.stdin?.end();
	});
}
