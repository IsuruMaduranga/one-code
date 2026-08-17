/**
 * Live-run registry for the subagent panel (Claude Code's below-editor agent
 * tree). One record per in-process child — foreground-parallel, background, or
 * resident — kept for the life of the session so the strip and the transcript
 * viewer render from a single source. The runner feeds it three signals:
 * `start` (register), progress events (activity/tokens/tool blocks), and the
 * final outcome (mark done/failed).
 *
 * Pure except for the change-callback fan-out; the row/transcript rendering
 * lives in panel-render.ts and reads snapshots from here.
 */

import { basename } from "node:path";
import { emptyUsage, type UsageTotals } from "./usage.ts";

export type LiveStatus = "running" | "idle" | "done" | "failed";

/** One rendered line of a child's transcript, mirroring the main-session marks. */
export interface TranscriptBlock {
	kind: "text" | "call" | "result";
	/** For a call: the tool name; for a result: the tool it belongs to. */
	tool?: string;
	/** Rendered short content (args summary, result summary, or assistant text). */
	text: string;
	isError?: boolean;
}

export interface LiveRun {
	taskId: string;
	/** Registry name (`general-purpose-1`), also the SendMessage handle. */
	name: string;
	agentType: string;
	model?: string;
	thinking?: string;
	/** Short human label shown in the row and the viewer chip (CC: "Efficiency review of diff"). */
	label: string;
	status: LiveStatus;
	startedAt: number;
	finishedAt?: number;
	toolCalls: number;
	tokens: UsageTotals;
	/** Live one-line activity ("Reading tui-render.ts"), derived from the latest tool call/text. */
	activity: string;
	/** Full transcript blocks, appended as events arrive (bounded by MAX_BLOCKS). */
	blocks: TranscriptBlock[];
}

/** Keep memory bounded for long/chatty children; the viewer scrolls the tail. */
export const MAX_BLOCKS = 400;

/** First non-empty line of the task, trimmed — the chip/row label. */
export function deriveLabel(task: string, fallback: string): string {
	const line = task.split("\n").map((l) => l.trim()).find(Boolean);
	if (!line) return fallback;
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * A short present-tense activity from the latest tool call, Claude Code style
 * ("Reading tui-render.ts", "Running tests", "Searching todo"). Falls back to
 * the first line of the latest assistant text, then a generic "Working…".
 */
export function deriveActivity(toolName: string | undefined, args: unknown, lastText: string): string {
	if (toolName) {
		const a = (args ?? {}) as Record<string, unknown>;
		const path = typeof a.file_path === "string" ? basename(a.file_path) : undefined;
		switch (toolName) {
			case "read":
			case "Read":
				return path ? `Reading ${path}` : "Reading a file";
			case "edit":
			case "Edit":
			case "write":
			case "Write":
				return path ? `Editing ${path}` : "Editing a file";
			case "bash":
			case "Bash":
				return "Running a command";
			case "grep":
			case "Grep":
				return typeof a.pattern === "string" ? `Searching ${truncate(a.pattern, 24)}` : "Searching";
			case "find":
			case "Glob":
			case "ls":
				return "Listing files";
			case "web_search":
			case "WebSearch":
				return "Searching the web";
			case "web_fetch":
			case "WebFetch":
				return "Fetching a page";
			default:
				return `Running ${toolName}`;
		}
	}
	const firstLine = lastText.split("\n").map((l) => l.trim()).find(Boolean);
	return firstLine ? truncate(firstLine, 48) : "Working…";
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface RegisterInput {
	taskId: string;
	name: string;
	agentType: string;
	model?: string;
	thinking?: string;
	task: string;
	startedAt: number;
}

/**
 * The registry. Emits `onChange` on every mutation (debounced by the widget,
 * not here). Records are never removed — a finished agent stays inspectable,
 * like Claude Code (and matches SendMessage's resume model).
 */
export class LiveRunRegistry {
	private readonly runs: LiveRun[] = [];
	private readonly byId = new Map<string, LiveRun>();
	private onChange: (() => void) | undefined;

	subscribe(cb: () => void): void {
		this.onChange = cb;
	}

	private changed(): void {
		this.onChange?.();
	}

	register(input: RegisterInput): void {
		const run: LiveRun = {
			taskId: input.taskId,
			name: input.name,
			agentType: input.agentType,
			model: input.model,
			thinking: input.thinking,
			label: deriveLabel(input.task, input.name),
			status: "running",
			startedAt: input.startedAt,
			toolCalls: 0,
			tokens: emptyUsage(),
			activity: "Starting…",
			blocks: [],
		};
		this.runs.push(run);
		this.byId.set(run.taskId, run);
		this.changed();
	}

	/** A progress tick from the tracker: refresh tokens/toolCalls. */
	stats(taskId: string, toolCalls: number, tokens: UsageTotals): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.toolCalls = toolCalls;
		run.tokens = tokens;
		if (run.status === "idle") run.status = "running";
		this.changed();
	}

	/** Update the one-line activity string (already derived). */
	setActivity(taskId: string, activity: string): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.activity = activity;
		if (run.status === "idle") run.status = "running";
		this.changed();
	}

	/** Append a transcript block (bounded). */
	block(taskId: string, block: TranscriptBlock): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.blocks.push(block);
		if (run.blocks.length > MAX_BLOCKS) run.blocks.splice(0, run.blocks.length - MAX_BLOCKS);
		this.changed();
	}

	/** A resident agent settled a turn but stays alive — mark idle, keep its totals. */
	settle(taskId: string): void {
		const run = this.byId.get(taskId);
		if (!run || run.status === "done" || run.status === "failed") return;
		run.status = "idle";
		run.activity = "Idle — waiting";
		this.changed();
	}

	/** Terminal: the run finished (or failed). */
	finish(taskId: string, failed: boolean): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.status = failed ? "failed" : "done";
		run.finishedAt = Date.now();
		run.activity = failed ? "Failed" : "Completed";
		this.changed();
	}

	get(taskId: string): LiveRun | undefined {
		return this.byId.get(taskId);
	}

	/** Newest-first, for the strip and viewer (main is prepended by the caller). */
	list(): LiveRun[] {
		return [...this.runs].reverse();
	}

	anyRunning(): boolean {
		return this.runs.some((r) => r.status === "running");
	}
}
