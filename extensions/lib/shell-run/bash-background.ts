/**
 * Background bash execution (pure module) — the process/spool half of the
 * bash override in index.ts.
 *
 * A background command spawns detached in its own process group, spools
 * stdout+stderr to memory (tail-capped) and to a log file when one is given,
 * and satisfies the BackgroundTask contract so task_output/task_stop work
 * unchanged. Robustness rules from working-docs/features/tools/records/background-bash.md: `output()`
 * never returns an empty body for a finished task (an explicitly-marked
 * "(no output)" beats an ambiguous blank a weak model reads as failure), and
 * the completion callback receives exactly what `output()` returns, so the
 * notification and task_output can never disagree.
 */

import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { BackgroundTask } from "../agents/task-registry.ts";
import { whenAborted } from "../core/abort.ts";
import { KILL_GRACE_MS, type OwnedTree, spawnOwnedTree, waitForChildExit } from "./process-tree.ts";
import { bashSpawnOrThrow, type ShellSpawn, spawnShellCommand } from "./shell-spawn.ts";
import type { ShellResultText } from "./shell-text.ts";

export const STORED_OUTPUT_CAP = 200_000;

/** The last `cap` characters, headed by `marker` when anything was cut. */
export function tailCap(text: string, cap: number, marker: string): string {
	return text.length <= cap ? text : `${marker}${text.slice(-cap)}`;
}

export interface BashFinishSummary {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** task_stop (or session shutdown) ended it. */
	stopped: boolean;
	/** The `timeout` deadline killed it. */
	timedOut: boolean;
	/** Exactly what task.output() returns — never empty. */
	output: string;
	/** The flushed spool, absent if writing it failed. */
	logPath?: string;
}

export interface StartBackgroundBashOptions {
	id: string;
	command: string;
	description: string;
	cwd: string;
	/** Kill the process tree after this many seconds. */
	timeoutSeconds?: number;
	logPath?: string;
	/**
	 * The interpreter to run `command` under. Default: the session's bash
	 * (lib/shell-run/shell-spawn.ts — Git Bash on Windows, `CLAUDE_CODE_GIT_BASH_PATH`
	 * honoured); the powershell extension passes its own spec.
	 */
	shell?: ShellSpawn;
	/**
	 * The profile's words for cut output. Passed in, not read from the
	 * profile, so this module loads in a plain Node process (the process-group
	 * test runs it there).
	 */
	text: Pick<ShellResultText, "earlierTruncated" | "spoolLost" | "emptyOutput">;
	onFinished(task: BackgroundTask, summary: BashFinishSummary): void;
}

/**
 * Run `command` under `shell` as an owned tree (lib/shell-run/process-tree.ts),
 * stdout and stderr piped, so a stop or a timeout signals the whole tree and
 * not only the `$SHELL -c` leader. What a finished shell leaves behind is
 * deliberate: no endGroupWithLauncher. Background shells and monitors start here.
 */
export function spawnOwnedShell({ shell, command, cwd }: { shell: ShellSpawn; command: string; cwd: string }): OwnedTree {
	return spawnOwnedTree((detached) => spawnShellCommand(shell, command, { cwd, ...detached, stdio: ["ignore", "pipe", "pipe"] }));
}

/**
 * What a shell task keeps of its output: the raw bytes in `logPath`, and the
 * last `STORED_OUTPUT_CAP` characters in memory for `task.output()`. A
 * background shell and a foreground run a key sent to the background
 * (foreground-run.ts) share it.
 */
export interface OutputSpool {
	/** The file while it holds everything written; undefined once a write failed, so a partial file is never named as the output. */
	logPath(): string | undefined;
	/** A writer for one stream: its own decoder, so a UTF-8 character split across two reads stays one character. */
	appender(): (chunk: Buffer) => void;
	/** Add text that is not the command's output (a spawn error). */
	note(text: string): void;
	/** What `task.output()` returns. */
	text(running: boolean): string;
	/** Flush the decoders and the file; resolves once `logPath` holds what `text` returns, or was dropped. */
	close(): Promise<void>;
}

export function createOutputSpool(logPath: string | undefined, text: StartBackgroundBashOptions["text"]): OutputSpool {
	let stored = "";
	let overflowed = false;
	let path = logPath;
	const log = logPath ? createWriteStream(logPath, { flags: "a" }) : undefined;
	// Never name a missing or partial file as the full output.
	log?.on("error", () => {
		path = undefined;
	});
	const decoders: StringDecoder[] = [];
	const add = (more: string) => {
		const all = stored + more;
		overflowed ||= all.length > STORED_OUTPUT_CAP;
		stored = tailCap(all, STORED_OUTPUT_CAP, text.earlierTruncated);
	};
	return {
		logPath: () => path,
		appender: () => {
			const decoder = new StringDecoder("utf8");
			decoders.push(decoder);
			return (chunk) => {
				add(decoder.write(chunk));
				// The log gets the raw bytes.
				if (path) log?.write(chunk);
			};
		},
		note: (more) => {
			stored = stored ? `${stored}\n${more}` : more;
		},
		text: (running) => (overflowed && !path ? `${text.spoolLost({ keptChars: STORED_OUTPUT_CAP })}${stored}` : stored || (running ? "" : text.emptyOutput)),
		close: () => {
			// An incomplete sequence at the very end decodes as U+FFFD, as it would have.
			const rest = decoders.map((decoder) => decoder.end()).join("");
			if (rest) add(rest);
			// end() flushes asynchronously; the file must not be short of what
			// text() returns when a reader is sent to it by the completion
			// notification. `close` follows a clean end and an error alike; a
			// stuck stream (a write that never calls back) must not keep the
			// task running, so after a second it is dropped and the partial
			// file is no longer named.
			if (!log || log.closed) return Promise.resolve();
			return new Promise((resolve) => {
				const fallback = setTimeout(() => {
					path = undefined;
					log.destroy();
					resolve();
				}, 1_000);
				log.once("close", () => {
					clearTimeout(fallback);
					resolve();
				});
				log.end();
			});
		},
	};
}

/** A running shell as the task list holds it: a background run, or a foreground one sent there. */
export function shellTask(p: Pick<BackgroundTask, "id" | "description" | "command" | "output" | "stop" | "finished"> & { logPath: () => string | undefined; startedAt?: number }): BackgroundTask {
	return {
		id: p.id,
		// "bash" for a PowerShell run too: the kind is what the shell panel lists.
		kind: "bash",
		description: p.description,
		command: p.command,
		status: "running",
		startedAt: p.startedAt ?? Date.now(),
		// Read each time: a failed write drops the file, so a partial one is never named.
		get logPath() {
			return p.logPath();
		},
		ownUI: true, // rendered live by the subagents panel's shell manager
		output: p.output,
		stop: p.stop,
		finished: p.finished,
	};
}

export function startBackgroundBash(options: StartBackgroundBashOptions): BackgroundTask {
	const tree = spawnOwnedShell({ shell: options.shell ?? bashSpawnOrThrow(), command: options.command, cwd: options.cwd });
	const child = tree.child;

	let ended = false;
	let stopRequested = false;
	let timedOut = false;
	const spool = createOutputSpool(options.logPath, options.text);
	child.stdout?.on("data", spool.appender());
	child.stderr?.on("data", spool.appender());

	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});

	const task: BackgroundTask = shellTask({
		id: options.id,
		description: options.description,
		command: options.command,
		logPath: spool.logPath,
		output: () => spool.text(task.status === "running"),
		stop: () => {
			stopRequested = true;
			// SIGTERM the tree, SIGKILL after the grace: a command that traps TERM
			// would otherwise never close, and a blocking one-shot run never return.
			tree.stop(KILL_GRACE_MS);
		},
		finished,
	});

	let timer: NodeJS.Timeout | undefined;
	if (options.timeoutSeconds && options.timeoutSeconds > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			tree.stop(KILL_GRACE_MS);
		}, options.timeoutSeconds * 1000);
		timer.unref?.();
	}

	const end = (status: BackgroundTask["status"], exitCode: number | null, signal: NodeJS.Signals | null) => {
		if (ended) return;
		ended = true;
		if (timer) clearTimeout(timer);
		// `finished` resolves only once the log file holds what output() returns.
		void spool.close().then(() => {
			task.status = status;
			task.finishedAt = Date.now();
			finish();
			options.onFinished(task, { exitCode, signal, stopped: stopRequested, timedOut, output: task.output(), logPath: task.logPath });
		});
	};

	// Exit plus a short stdio grace, not `close`: a descendant the stop missed
	// must not keep the task "running" for its whole life (lib/shell-run/process-tree.ts).
	waitForChildExit(child).then(
		({ code, signal }) => end(stopRequested ? "stopped" : timedOut || code !== 0 ? "failed" : "completed", code, signal),
		(error: Error) => {
			spool.note(error.message);
			end("failed", null, null);
		},
	);

	return task;
}

/**
 * Run a background command to completion and resolve with its summary — the
 * shape the one-shot modes need (`-p` / `--mode json`): the process exits when
 * the turn settles, so a detached task would be orphaned with its completion
 * undelivered — and, worse, its late callback would call `sendMessage` on the
 * disposed session and crash pi (STEERING-REVIEW-2026-09-05 H3). The tool's
 * abort signal stops the process tree; the summary then reports `stopped`.
 */
export function runBackgroundBashBlocking(
	options: Omit<StartBackgroundBashOptions, "onFinished">,
	signal?: AbortSignal,
): Promise<BashFinishSummary> {
	return new Promise((resolve) => {
		let unhook = () => {};
		const task = startBackgroundBash({
			...options,
			onFinished: (_task, summary) => {
				unhook();
				resolve(summary);
			},
		});
		unhook = whenAborted(signal, () => task.stop());
	});
}
