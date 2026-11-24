/**
 * A foreground shell run that can be sent to the background while it runs.
 *
 * Claude Code gives every shell run a task id when it starts and writes its
 * output to `tasks/<task id>.output` from the first byte. Its Ctrl+B then
 * only lets go of the wait: the command keeps running as a background task,
 * the tool call returns at once, and the usual completion notification
 * follows when the command exits. A foreground run that ends by itself
 * leaves no file there.
 *
 * pi's shell tool owns the foreground process, but it runs the command
 * through pluggable operations. `detachable` wraps those: the wrapper holds
 * the deadline and the abort signal itself, so letting go clears both (a
 * backgrounded command has no deadline, and an Esc no longer reaches it)
 * while pi's own executor keeps the process and its output handling.
 *
 * A run is found by the abort signal pi's tool hands its operations, which is
 * the signal the caller passed to that tool: `ForegroundRun.signal`.
 */

import { rmSync } from "node:fs";
import { whenAborted } from "../core/abort.ts";
import { createOutputSpool, type OutputSpool, type StartBackgroundBashOptions } from "./bash-background.ts";

/** pi's shell operations (`BashOperations`), structurally. */
export interface ShellOperations {
	exec: (
		command: string,
		cwd: string,
		options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
	) => Promise<{ exitCode: number | null }>;
}

/** How a backgrounded run ended. */
export interface ForegroundRunEnd {
	exitCode: number | null;
	/** A stop ended it, not the command. */
	stopped: boolean;
}

const ABORTED = "aborted";
const runs = new WeakMap<AbortSignal, ForegroundRun>();

export class ForegroundRun {
	/** Pass this to pi's shell tool in place of the call's own signal. */
	readonly signal: AbortSignal;
	/** Resolves when `detach` takes; never when the run ends in the foreground. */
	readonly detached: Promise<void>;
	/** After a detach: resolves when the command ends, its output file flushed. Never rejects. */
	readonly ended: Promise<ForegroundRunEnd>;

	/** When the run was made, for the task a detach turns it into. */
	readonly startedAt = Date.now();

	private readonly process = new AbortController();
	private readonly spool: OutputSpool;
	private readonly unhook: () => void;
	private state: "idle" | "running" | "detached" | "ended" = "idle";
	private timer: NodeJS.Timeout | undefined;
	private timedOut = false;
	private stopRequested = false;
	private markDetached!: () => void;
	private markEnded!: (end: ForegroundRunEnd) => void;

	constructor(
		readonly logPath: string | undefined,
		text: StartBackgroundBashOptions["text"],
		caller?: AbortSignal,
	) {
		// pi's tool sees a signal of the run's own, which follows the caller's
		// abort only while the run is attached. Should pi ever hand its
		// operations another signal, the lookup misses and the command runs
		// undetachable, but an Esc still stops it.
		const tool = new AbortController();
		this.signal = tool.signal;
		this.spool = createOutputSpool(logPath, text);
		this.detached = new Promise((resolve) => {
			this.markDetached = resolve;
		});
		this.ended = new Promise((resolve) => {
			this.markEnded = resolve;
		});
		this.unhook = whenAborted(caller, () => {
			if (this.state === "detached") return;
			this.process.abort();
			tool.abort();
		});
		runs.set(this.signal, this);
	}

	/** True while the command runs in the foreground: the only state a detach takes. */
	get running(): boolean {
		return this.state === "running";
	}

	/** True once a detach took. */
	private get released(): boolean {
		return this.state === "detached";
	}

	/** What the task's `output()` returns once the run is in the background. */
	output(): string {
		return this.spool.text(this.state !== "ended");
	}

	/** The output file while it holds the whole output. */
	outputFile(): string | undefined {
		return this.spool.logPath();
	}

	/**
	 * Send the run to the background: clear its deadline, stop following the
	 * caller's abort, and settle the foreground wait. False when the command
	 * is not running (not started yet, or already over).
	 */
	detach(): boolean {
		// A command already being stopped (its deadline, an Esc) is not kept: its end is that stop's to report.
		if (this.state !== "running" || this.process.signal.aborted) return false;
		this.state = "detached";
		if (this.timer) clearTimeout(this.timer);
		this.unhook();
		this.markDetached();
		return true;
	}

	/** Stop a backgrounded run (task_stop, session shutdown). */
	stop(): void {
		this.stopRequested = true;
		this.process.abort();
	}

	/** The foreground run is over and was not detached: drop its output file, as Claude Code keeps none. */
	async discard(): Promise<void> {
		this.unhook();
		await this.spool.close();
		try {
			if (this.logPath) rmSync(this.logPath, { force: true });
		} catch {
			// Best effort (a file another process holds, on Windows): the command's result must not turn into this error.
		}
	}

	/** Run `command` through `inner`; called by the wrapped operations. */
	async exec(inner: ShellOperations, command: string, cwd: string, options: Parameters<ShellOperations["exec"]>[2]): Promise<{ exitCode: number | null }> {
		if (this.process.signal.aborted) throw new Error(ABORTED);
		this.state = "running";
		const spool = this.spool.appender();
		const seconds = options.timeout;
		if (seconds !== undefined && seconds > 0) {
			this.timer = setTimeout(() => {
				this.timedOut = true;
				this.process.abort();
			}, seconds * 1000);
		}
		// pi gets no timeout: its own timer could not be cleared at a detach.
		const settled = inner
			.exec(command, cwd, {
				onData: (data) => {
					spool(data);
					if (this.state === "running") options.onData(data);
				},
				signal: this.process.signal,
				env: options.env,
			})
			.then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
		const first = await Promise.race([settled, this.detached.then(() => "released" as const)]);
		// The state decides, not the race: a detach that took owns the command's end even if the command settled first.
		if (first === "released" || this.released) {
			// The command lives on; its end is the task's, not this call's.
			void settled.then(async (outcome) => {
				this.state = "ended";
				await this.spool.close();
				this.markEnded({ exitCode: "result" in outcome ? outcome.result.exitCode : null, stopped: this.stopRequested });
			});
			// pi's tool ends its wait; the caller already took the detach and drops this result.
			throw new Error(ABORTED);
		}
		if (this.timer) clearTimeout(this.timer);
		this.state = "ended";
		if ("result" in first) return first.result;
		// The deadline stopped it: the error pi words as a timeout.
		if (this.timedOut && first.error instanceof Error && first.error.message === ABORTED) throw new Error(`timeout:${seconds}`);
		throw first.error;
	}
}

/**
 * `inner` with every run that a `ForegroundRun` was started for made
 * detachable; any other call passes through untouched.
 */
export function detachable(inner: ShellOperations): ShellOperations {
	return {
		exec: (command, cwd, options) => {
			const run = options.signal ? runs.get(options.signal) : undefined;
			return run ? run.exec(inner, command, cwd, options) : inner.exec(command, cwd, options);
		},
	};
}
