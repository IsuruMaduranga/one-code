/**
 * Background bash execution (pure module) — the process/spool half of the
 * bash override in index.ts.
 *
 * A background command spawns detached in its own process group, spools
 * stdout+stderr to memory (tail-capped) and to a log file when one is given,
 * and satisfies the BackgroundTask contract so task_output/task_stop work
 * unchanged. Robustness rules from docs/features/tools/records/background-bash.md: `output()`
 * never returns an empty body for a finished task (an explicitly-marked
 * "(no output)" beats an ambiguous blank a weak model reads as failure), and
 * the completion callback receives exactly what `output()` returns, so the
 * notification and task_output can never disagree.
 */

import { createWriteStream } from "node:fs";
import type { BackgroundTask } from "../background/registry.ts";
import { whenAborted } from "../lib/abort.ts";
import { detachedSpawnOptions, KILL_GRACE_MS, stopProcessTree } from "../lib/process-tree.ts";
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
	/** Task kind on the registry; "bash" (the default) is what the shell panel lists. */
	kind?: BackgroundTask["kind"];
	onFinished(task: BackgroundTask, summary: BashFinishSummary): void;
}

export function startBackgroundBash(options: StartBackgroundBashOptions): BackgroundTask {
	// Own process group, so stop/timeout can signal the whole tree (lib/process-tree.ts).
	const child = spawnShellCommand(options.shell ?? bashSpawnOrThrow(), options.command, {
		cwd: options.cwd,
		...detachedSpawnOptions(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stored = "";
	let ended = false;
	let stopRequested = false;
	let timedOut = false;
	const log = options.logPath ? createWriteStream(options.logPath, { flags: "a" }) : undefined;
	log?.on("error", () => {
		// Spooling to disk is best-effort; the in-memory tail stays authoritative.
	});

	const append = (chunk: Buffer) => {
		const text = chunk.toString();
		stored = tailCap(stored + text, STORED_OUTPUT_CAP);
		log?.write(text);
	};
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);

	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});

	const task: BackgroundTask = {
		id: options.id,
		kind: options.kind ?? "bash",
		description: options.description,
		command: options.command,
		status: "running",
		startedAt: Date.now(),
		logPath: options.logPath,
		ownUI: true, // rendered live by the subagents panel's shell manager
		output: () => stored || (task.status === "running" ? "" : EMPTY_OUTPUT_MARKER),
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
		task.status = status;
		task.finishedAt = Date.now();
		const complete = () => {
			finish();
			options.onFinished(task, { exitCode, signal, stopped: stopRequested, timedOut, output: task.output() });
		};
		// end() flushes asynchronously; `finished` must not resolve while the
		// log file is still short of what output() returns, or a reader sent to
		// logPath by the completion notification can see a truncated file. The
		// callback also fires if the stream errors, so this cannot hang.
		if (log) log.end(complete);
		else complete();
	};

	child.on("error", (error) => {
		stored = stored ? `${stored}\n${error.message}` : error.message;
		end("failed", null, null);
	});
	child.on("close", (code, signal) => {
		end(stopRequested ? "stopped" : timedOut || code !== 0 ? "failed" : "completed", code, signal);
	});

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
