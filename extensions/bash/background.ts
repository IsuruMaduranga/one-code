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

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { BackgroundTask } from "../background/registry.ts";

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
	onFinished(task: BackgroundTask, summary: BashFinishSummary): void;
}

function killTree(child: ChildProcess): void {
	if (child.pid == null) return;
	// Detached → own process group; negative pid signals the whole tree.
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// Already gone.
		}
	}
}

export function startBackgroundBash(options: StartBackgroundBashOptions): BackgroundTask {
	const child = spawn(process.env.SHELL || "/bin/sh", ["-c", options.command], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
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
		kind: "bash",
		description: options.description,
		status: "running",
		startedAt: Date.now(),
		logPath: options.logPath,
		output: () => stored || (task.status === "running" ? "" : EMPTY_OUTPUT_MARKER),
		stop: () => {
			stopRequested = true;
			killTree(child);
		},
		finished,
	};

	let timer: NodeJS.Timeout | undefined;
	if (options.timeoutSeconds && options.timeoutSeconds > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, options.timeoutSeconds * 1000);
		timer.unref?.();
	}

	const end = (status: BackgroundTask["status"], exitCode: number | null, signal: NodeJS.Signals | null) => {
		if (ended) return;
		ended = true;
		if (timer) clearTimeout(timer);
		task.status = status;
		task.finishedAt = Date.now();
		log?.end();
		finish();
		options.onFinished(task, { exitCode, signal, stopped: stopRequested, timedOut, output: task.output() });
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
