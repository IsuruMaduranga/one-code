import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Whether a process is alive, and a bounded wait for a condition on processes. */
export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** A process's parent pid and process group, read from `ps` (POSIX only). */
export const parentAndGroup = (pid: number): { ppid: number; pgid: number } => {
	const [ppid, pgid] = execFileSync("ps", ["-o", "ppid=,pgid=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
	return { ppid, pgid };
};

/** Poll every 50 ms, at most `tries` times (3 s by default); the condition's last value. */
export const until = async (condition: () => boolean, tries = 60): Promise<boolean> => {
	for (let i = 0; i < tries && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	return condition();
};

/** An owner process started by `startOwner`. */
export interface Owner {
	owner: ChildProcessWithoutNullStreams;
	/** Resolves with `[code, signal]` when the owner exits. */
	exited: Promise<unknown[]>;
	/** The first chunk the owner wrote to stdout: its ready line. */
	ready: string;
	/** SIGKILL the owner if it is still running. */
	kill(): void;
}

/**
 * Run `script` as an ES module in its own Node process, the owner of the
 * processes a test then watches as the owner ends (quits, crashes, dies of a
 * signal). Resolves once the owner writes its first stdout chunk; rejects
 * with its stderr when it exits first. Callers end it with `kill()` in a
 * `finally`.
 */
export async function startOwner(script: string): Promise<Owner> {
	const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
	const exited = once(owner, "exit");
	let stderr = "";
	owner.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const kill = () => {
		if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
	};
	try {
		const [chunk] = await Promise.race([once(owner.stdout, "data"), exited.then(() => Promise.reject(new Error(`owner exited before ready: ${stderr}`)))]);
		return { owner, exited, ready: String(chunk), kill };
	} catch (error) {
		kill();
		throw error;
	}
}

/** An owner running a finished background shell that left a worker in its group. */
export interface ShellOwner extends Owner {
	/** The background shell's process group. */
	group: number;
	/** The worker the shell left behind. */
	worker: number;
	/** `kill()`, and SIGKILL the group and the worker. */
	cleanup(): void;
}

/**
 * Start an owner that runs `command` as a background shell
 * (lib/shell-run/bash-background.ts) to its end and writes the shell's
 * output: `command` prints `$$ $!`, the group and the worker. The owner keeps
 * itself alive with an interval named `keepAlive` and runs `onInput` when
 * written to; `preamble` runs before the shell starts.
 */
export async function startShellOwner(command: string, onInput: string, preamble = ""): Promise<ShellOwner> {
	const moduleUrl = pathToFileURL(resolve("extensions/lib/shell-run/bash-background.ts")).href;
	const run = await startOwner(
		[
			`import { runBackgroundBashBlocking } from ${JSON.stringify(moduleUrl)};`,
			preamble,
			`const keepAlive = setInterval(() => {}, 1000);`,
			`const result = await runBackgroundBashBlocking({ text: { earlierTruncated: '', spoolLost: () => '', emptyOutput: '' }, id: 'owner-test', command: ${JSON.stringify(command)}, description: 'worker', cwd: process.cwd() });`,
			`process.stdout.write(result.output);`,
			`process.stdin.once('data', () => { ${onInput} });`,
		].join("\n"),
	);
	const [group, worker] = run.ready.trim().split(/\s+/).map(Number);
	return {
		...run,
		group,
		worker,
		cleanup: () => {
			run.kill();
			for (const target of [-group, worker]) {
				try {
					process.kill(target, "SIGKILL");
				} catch {
					// Gone.
				}
			}
		},
	};
}
