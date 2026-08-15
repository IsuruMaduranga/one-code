/**
 * Run lifecycle: registry of live/finished runs, background execution,
 * abort layering, journaling glue, and resume seeding.
 *
 * Each run persists under `<sessionDir>/workflows/<runId>/` — `script.js`
 * (the exact source executed) and `journal.jsonl` (completed agent calls).
 * The directory is keyed by cwd via pi's session dir, so `resumeFromRunId`
 * works across sessions and restarts. Background runs do NOT survive the
 * process: session_shutdown aborts them (index.ts wires that); the journal
 * makes an aborted run cheap to resume.
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { AgentRunner } from "./agent-session.ts";
import { createScriptGlobals, MAX_CONCURRENCY, MAX_AGENTS_PER_RUN, type ScriptRunState } from "./globals.ts";
import { appendJournal, readJournal, ReplayCursor } from "./journal.ts";
import { AgentRecordStore, previewValue } from "./records.ts";
import { findSavedWorkflow } from "./saved-workflows.ts";
import { parseWorkflowScript } from "./script-source.ts";
import { runWorkflowScript } from "./vm-runtime.ts";
import type { RunProgressEvent, RunStatus, WorkflowMeta } from "./types.ts";
import { WorkflowScriptError } from "./types.ts";
import type { ViewerRunSnapshot } from "./viewer.ts";

const WALL_CLOCK_CAP_MS = 30 * 60 * 1000;
const RECENT_EVENTS_CAP = 200;
const RESULT_CAP = 30_000;

export interface StartRunOptions {
	script: string;
	args: unknown;
	tokenBudget: number | null;
	resumeFromRunId?: string;
	cwd: string;
	sessionDir: string;
	defaultModel: unknown;
	configuredDefaultModel?: string;
	defaultEffort?: string;
}

export class RunHandle extends EventEmitter {
	status: RunStatus = "running";
	result?: unknown;
	errorMessage?: string;
	readonly startedAt = Date.now();
	finishedAt?: number;
	readonly recentEvents: string[] = [];
	/** Per-agent records folded from the event stream (the viewer's data). */
	readonly agents = new AgentRecordStore();
	state?: ScriptRunState;
	/** Settles when the run reaches a terminal status (never rejects). */
	finished!: Promise<RunHandle>;
	private controller = new AbortController();
	private resolveFinished!: (handle: RunHandle) => void;

	readonly runId: string;
	readonly meta: WorkflowMeta;
	readonly runDir: string;
	readonly scriptPath: string;
	readonly resumed: boolean;

	constructor(runId: string, meta: WorkflowMeta, runDir: string, scriptPath: string, resumed: boolean) {
		super();
		this.runId = runId;
		this.meta = meta;
		this.runDir = runDir;
		this.scriptPath = scriptPath;
		this.resumed = resumed;
		this.finished = new Promise((resolve) => {
			this.resolveFinished = resolve;
		});
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	record(event: RunProgressEvent): void {
		this.agents.apply(event);
		const line = formatEvent(event);
		if (line) {
			this.recentEvents.push(line);
			if (this.recentEvents.length > RECENT_EVENTS_CAP) this.recentEvents.shift();
		}
		this.emit("progress", event);
	}

	abort(reason: string): void {
		if (this.status !== "running") return;
		// First reason wins — a user stop shouldn't be masked by the script's
		// consequent "aborted" error.
		this.errorMessage ??= reason;
		this.controller.abort();
	}

	finish(status: RunStatus, result?: unknown, errorMessage?: string): void {
		if (this.status !== "running") return;
		this.status = status;
		this.result = result;
		this.errorMessage ??= errorMessage;
		this.finishedAt = Date.now();
		this.emit("done", this);
		this.resolveFinished(this);
	}
}

function formatEvent(event: RunProgressEvent): string | undefined {
	switch (event.type) {
		case "log":
			return `• ${event.text}`;
		case "phase":
			return `— ${event.phase} —`;
		case "agentStart":
			return `⏳ ${event.label}${event.phase ? ` [${event.phase}]` : ""}`;
		case "agentEnd":
			if (event.text) return `✗ ${event.label}: ${event.text}`;
			return `✓ ${event.label}${event.replayed ? " (replayed)" : ""}${event.tokens ? ` · ${event.tokens.output} out` : ""}`;
		default:
			return undefined;
	}
}

/** Immutable view of a run for the pure renderers (viewer + status strip). */
export function snapshotRun(handle: RunHandle): ViewerRunSnapshot {
	return {
		runId: handle.runId,
		name: handle.meta.name,
		description: handle.meta.description,
		status: handle.status,
		startedAt: handle.startedAt,
		finishedAt: handle.finishedAt,
		errorMessage: handle.errorMessage,
		agents: handle.agents.list(),
	};
}

export class WorkflowRunManager {
	private runs = new Map<string, RunHandle>();

	list(): RunHandle[] {
		return [...this.runs.values()];
	}

	/** All runs as viewer snapshots, newest first (the display order). */
	snapshots(): ViewerRunSnapshot[] {
		return this.list().map(snapshotRun).reverse();
	}

	get(runId: string): RunHandle | undefined {
		return this.runs.get(runId);
	}

	abort(runId: string, reason: string): boolean {
		const handle = this.runs.get(runId);
		if (!handle || handle.status !== "running") return false;
		handle.abort(reason);
		return true;
	}

	abortAll(reason: string): void {
		for (const handle of this.runs.values()) handle.abort(reason);
	}

	hasActiveRuns(): boolean {
		return this.list().some((h) => h.status === "running");
	}

	/** Parse, persist, and launch a run. Throws synchronously on a bad script/resume id. */
	start(options: StartRunOptions): RunHandle {
		const { meta, body } = parseWorkflowScript(options.script);

		const resumed = Boolean(options.resumeFromRunId);
		const runId = options.resumeFromRunId ?? `wf_${randomBytes(5).toString("hex")}`;
		if (!/^wf_[a-z0-9-]{6,}$/.test(runId)) {
			throw new WorkflowScriptError(`Invalid runId "${runId}"`);
		}
		const runDir = join(options.sessionDir, "workflows", runId);
		const journalPath = join(runDir, "journal.jsonl");

		let replay: ReplayCursor | undefined;
		if (resumed) {
			if (this.runs.get(runId)?.status === "running") {
				throw new WorkflowScriptError(`Run ${runId} is still running — stop it before resuming`);
			}
			if (!existsSync(runDir)) {
				throw new WorkflowScriptError(`resumeFromRunId ${runId} not found under ${join(options.sessionDir, "workflows")}`);
			}
			replay = new ReplayCursor(readJournal(journalPath));
		}
		mkdirSync(runDir, { recursive: true });
		const scriptPath = join(runDir, "script.js");
		writeFileSync(scriptPath, options.script, "utf8");

		const handle = new RunHandle(runId, meta, runDir, scriptPath, resumed);
		this.runs.set(runId, handle);
		void this.execute(handle, body, options, journalPath, replay);
		return handle;
	}

	private async execute(
		handle: RunHandle,
		body: string,
		options: StartRunOptions,
		journalPath: string,
		replay: ReplayCursor | undefined,
	): Promise<void> {
		const wallClock = setTimeout(
			() => handle.abort(`wall-clock cap reached (${WALL_CLOCK_CAP_MS / 60000} minutes)`),
			WALL_CLOCK_CAP_MS,
		);
		wallClock.unref?.();

		let runner: AgentRunner | undefined;
		try {
			runner = await AgentRunner.create({
				cwd: options.cwd,
				defaultModel: options.defaultModel,
				configuredDefaultModel: options.configuredDefaultModel,
				defaultEffort: options.defaultEffort as never,
				onNotice: (message) => handle.record({ type: "log", text: `⚠ ${message}` }),
			});

			const { globals, state } = createScriptGlobals({
				agentCall: (prompt, opts, onUpdate) => runner!.run(prompt, opts, handle.signal, onUpdate),
				args: options.args,
				budgetTotal: options.tokenBudget,
				concurrency: defaultConcurrency(),
				signal: handle.signal,
				onEvent: (event) => handle.record(event),
				onJournal: (entry) => appendJournal(journalPath, entry),
				replay,
				runWorkflow: (nameOrRef, childArgs) => this.runChild(handle, runner!, options, nameOrRef, childArgs, () => state),
			});
			handle.state = state;

			const result = await runWorkflowScript(body, globals, `${handle.meta.name}.js`);
			handle.finish(handle.signal.aborted ? "aborted" : "completed", result);
		} catch (error) {
			const aborted = handle.signal.aborted;
			// Stop in-flight sibling agents instead of letting a doomed batch run on.
			handle.abort((error as Error).message);
			handle.finish(aborted ? "aborted" : "failed", undefined, (error as Error).message);
		} finally {
			clearTimeout(wallClock);
			runner?.dispose();
		}
	}

	/** One level of workflow() nesting: child shares the runner/signal, gets the remaining caps. */
	private async runChild(
		parent: RunHandle,
		runner: AgentRunner,
		options: StartRunOptions,
		nameOrRef: unknown,
		childArgs: unknown,
		parentState: () => ScriptRunState,
	): Promise<unknown> {
		let source: string;
		let label: string;
		if (typeof nameOrRef === "string") {
			const saved = findSavedWorkflow(options.cwd, os.homedir(), nameOrRef);
			if (!saved) throw new WorkflowScriptError(`workflow("${nameOrRef}"): no saved workflow with that name`);
			source = readFileSync(saved.path, "utf8");
			label = nameOrRef;
		} else if (nameOrRef && typeof nameOrRef === "object" && typeof (nameOrRef as { scriptPath?: unknown }).scriptPath === "string") {
			const path = (nameOrRef as { scriptPath: string }).scriptPath;
			if (!existsSync(path)) throw new WorkflowScriptError(`workflow({scriptPath}): ${path} does not exist`);
			source = readFileSync(path, "utf8");
			label = path;
		} else {
			throw new WorkflowScriptError("workflow() takes a saved-workflow name or {scriptPath}");
		}

		const { meta, body } = parseWorkflowScript(source);
		const state = parentState();
		const remainingAgents = Math.max(0, MAX_AGENTS_PER_RUN - state.agentCount());
		const remainingBudget =
			options.tokenBudget === null ? null : Math.max(0, options.tokenBudget - state.outputTokens());

		// Child calls are not journaled in v1: resume replays the parent's own
		// agent() prefix only. Progress is forwarded under a "▸ name" phase.
		const { globals } = createScriptGlobals({
			agentCall: (prompt, opts, onUpdate) => runner.run(prompt, opts, parent.signal, onUpdate),
			args: childArgs,
			budgetTotal: remainingBudget,
			concurrency: defaultConcurrency(),
			maxAgents: remainingAgents,
			signal: parent.signal,
			onEvent: (event) =>
				parent.record({
					...event,
					// source keeps child records distinct (a child restarts callIndex at
					// 0); the phase prefix is the visible grouping in widget and viewer.
					source: meta.name,
					phase: `▸ ${meta.name}${event.phase ? ` · ${event.phase}` : ""}`,
				}),
		});
		return runWorkflowScript(body, globals, `${label}.js`);
	}
}

export function defaultConcurrency(): number {
	return Math.min(MAX_CONCURRENCY, Math.max(1, os.cpus().length - 2));
}

/** Human/LLM-facing completion report, delivered as the followUp message. */
export function buildRunReport(handle: RunHandle): string {
	const state = handle.state;
	const duration = handle.finishedAt ? Math.round((handle.finishedAt - handle.startedAt) / 1000) : 0;
	const statsLine = state
		? `${state.agentCount()} agent(s), ${state.outputTokens()} output tokens, $${state.cost().toFixed(4)}, ${duration}s`
		: `${duration}s`;

	if (handle.status === "completed") {
		const resultText =
			handle.result === undefined
				? "(script returned no value)"
				: previewValue(handle.result, RESULT_CAP, "\n… (truncated)");
		return `Workflow **${handle.meta.name}** (${handle.runId}) completed — ${statsLine}.\n\nResult:\n${resultText}`;
	}

	const tail = handle.recentEvents.slice(-5).join("\n");
	return `Workflow **${handle.meta.name}** (${handle.runId}) ${handle.status} — ${statsLine}.\nReason: ${handle.errorMessage ?? "unknown"}${tail ? `\nRecent progress:\n${tail}` : ""}\nCompleted agent calls are journaled; re-invoke the workflow tool with resumeFromRunId: "${handle.runId}" to continue from where it stopped.`;
}
