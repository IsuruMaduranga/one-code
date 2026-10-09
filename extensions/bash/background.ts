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
import type { BackgroundTask } from "../background/registry.ts";
import { whenAborted } from "../lib/abort.ts";
import { detachedSpawnOptions, KILL_GRACE_MS, rememberProcessGroup, stopProcessTree, waitForChildExit } from "../lib/process-tree.ts";
import { bashSpawnOrThrow, type ShellSpawn, spawnShellCommand } from "../lib/shell-spawn.ts";

export const STORED_OUTPUT_CAP = 200_000;

export const EMPTY_OUTPUT_MARKER = "(no output — the command wrote nothing to stdout or stderr)";

export function tailCap(text: string, cap: number): string {
	return text.length <= cap ? text : `… (earlier output truncated)\n${text.slice(-cap)}`;
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
	 * (lib/shell-spawn.ts — Git Bash on Windows, `CLAUDE_CODE_GIT_BASH_PATH`
	 * honoured); the powershell extension passes its own spec.
	 */
	shell?: ShellSpawn;
	onFinished(task: BackgroundTask, summary: BashFinishSummary): void;
}

export function startBackgroundBash(options: StartBackgroundBashOptions): BackgroundTask {
	// Own process group, so stop/timeout can signal the whole tree (lib/process-tree.ts).
	const child = spawnShellCommand(options.shell ?? bashSpawnOrThrow(), options.command, {
		cwd: options.cwd,
		...detachedSpawnOptions(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	rememberProcessGroup(child);

	let stored = "";
	let overflowed = false;
	let spoolFailed = false;
	let ended = false;
	let stopRequested = false;
	let timedOut = false;
	const log = options.logPath ? createWriteStream(options.logPath, { flags: "a" }) : undefined;
	log?.on("error", () => {
		// Never name a missing or partial file as the full output.
		spoolFailed = true;
		task.logPath = undefined;
	});

	// One streaming decoder per stream: a UTF-8 character split across two
	// reads must not become two U+FFFD. The log gets the raw bytes.
	const stdoutText = new StringDecoder("utf8");
	const stderrText = new StringDecoder("utf8");
	const appender = (decoder: StringDecoder) => (chunk: Buffer) => {
		const text = stored + decoder.write(chunk);
		overflowed ||= text.length > STORED_OUTPUT_CAP;
		stored = tailCap(text, STORED_OUTPUT_CAP);
		if (!spoolFailed) log?.write(chunk);
	};
	child.stdout?.on("data", appender(stdoutText));
	child.stderr?.on("data", appender(stderrText));

	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});

	const task: BackgroundTask = {
		id: options.id,
		// "bash" for a PowerShell run too: the kind is what the shell panel lists.
		kind: "bash",
		description: options.description,
		command: options.command,
		status: "running",
		startedAt: Date.now(),
		logPath: options.logPath,
		ownUI: true, // rendered live by the subagents panel's shell manager
		output: () => overflowed && !task.logPath
			? `[The command's spool file could not be written, so only the last ${STORED_OUTPUT_CAP.toLocaleString("en-US")} characters of its output were kept.]\n${stored}`
			: stored || (task.status === "running" ? "" : EMPTY_OUTPUT_MARKER),
		stop: () => {
			stopRequested = true;
			// SIGTERM the tree, SIGKILL after the grace: a command that traps TERM
			// would otherwise never close, and a blocking one-shot run never return.
			stopProcessTree(child, KILL_GRACE_MS);
		},
		finished,
	};

	let timer: NodeJS.Timeout | undefined;
	if (options.timeoutSeconds && options.timeoutSeconds > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			stopProcessTree(child, KILL_GRACE_MS);
		}, options.timeoutSeconds * 1000);
		timer.unref?.();
	}

	const end = (status: BackgroundTask["status"], exitCode: number | null, signal: NodeJS.Signals | null) => {
		if (ended) return;
		ended = true;
		if (timer) clearTimeout(timer);
		// An incomplete sequence at the very end decodes as U+FFFD, as it would have.
		const rest = stdoutText.end() + stderrText.end();
		if (rest) stored = tailCap(stored + rest, STORED_OUTPUT_CAP);
		let completed = false;
		const complete = () => {
			if (completed) return;
			completed = true;
			task.status = status;
			task.finishedAt = Date.now();
			finish();
			options.onFinished(task, { exitCode, signal, stopped: stopRequested, timedOut, output: task.output(), logPath: task.logPath });
		};
		// end() flushes asynchronously; `finished` must not resolve while the
		// log file is still short of what output() returns, or a reader sent to
		// logPath by the completion notification can see a truncated file.
		// `close` follows a clean end and an error alike; a stuck stream (a
		// write that never calls back) must not keep the task running, so after
		// a second it is dropped and the partial file is no longer named.
		if (log && !log.closed) {
			const fallback = setTimeout(() => {
				spoolFailed = true;
				task.logPath = undefined;
				log.destroy();
				complete();
			}, 1_000);
			log.once("close", () => {
				clearTimeout(fallback);
				complete();
			});
			log.end();
		} else {
			complete();
		}
	};

	// Exit plus a short stdio grace, not `close`: a descendant the stop missed
	// must not keep the task "running" for its whole life (lib/process-tree.ts).
	waitForChildExit(child).then(
		({ code, signal }) => end(stopRequested ? "stopped" : timedOut || code !== 0 ? "failed" : "completed", code, signal),
		(error: Error) => {
			stored = stored ? `${stored}\n${error.message}` : error.message;
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
