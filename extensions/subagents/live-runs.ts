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
import { cutPlainText, firstNonEmptyLine } from "../lib/tui-render.ts";
import { normalizeToolName } from "../permissions/matcher.ts";
import { emptyUsage, sumUsage, type UsageTotals } from "./usage.ts";

export type LiveStatus = "running" | "idle" | "done" | "failed";

/** One rendered block of a child's transcript, mirroring the main-session marks. */
export interface TranscriptBlock {
	kind: "task" | "text" | "call" | "result";
	/** For a call: the tool name; for a result: the tool it belongs to. */
	tool?: string;
	/** Rendered short content (args summary, result summary, or assistant text). */
	text: string;
	isError?: boolean;
}

/** The shape of a streaming assistant message (pi's message_update payload). */
export interface StreamingMessage {
	content?: unknown;
}

/**
 * Assistant text of an in-flight message. Extraction is deliberately lazy —
 * message_update fires per token carrying the whole message-so-far, so the
 * registry stores only the reference and the viewer extracts at paint time.
 */
export function streamingText(message: StreamingMessage | undefined): string {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks
		.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
		.map((b) => b.text)
		.join("");
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
	/** The in-flight assistant message (whole-so-far), cleared at message_end. */
	streaming?: StreamingMessage;
	/**
	 * Lifetime totals carried over from before a resume — a resumed run's fresh
	 * tracker restarts at 0, so stats() adds the current turn on top of these
	 * instead of visibly regressing the run's cost.
	 */
	baseToolCalls: number;
	baseTokens: UsageTotals;
}

/** Keep memory bounded for long/chatty children; the viewer scrolls the tail. */
export const MAX_BLOCKS = 400;

/** First non-empty line of the task, trimmed — the chip/row label. */
export function deriveLabel(task: string, fallback: string): string {
	const line = firstNonEmptyLine(task);
	return line ? cutPlainText(line, 60) : fallback;
}

/**
 * A short present-tense activity from the latest tool call, Claude Code style
 * ("Reading tui-render.ts", "Running tests", "Searching todo"). Tool names go
 * through the canonical CC↔pi alias table (permissions/matcher.ts), so both
 * spellings resolve without a second table here. Falls back to the first line
 * of the latest assistant text, then a generic "Working…".
 */
export function deriveActivity(toolName: string | undefined, args: unknown, lastText: string): string {
	if (toolName) {
		const a = (args ?? {}) as Record<string, unknown>;
		const path = typeof a.file_path === "string" ? basename(a.file_path) : undefined;
		switch (normalizeToolName(toolName)) {
			case "read":
				return path ? `Reading ${path}` : "Reading a file";
			case "edit":
			case "write":
				return path ? `Editing ${path}` : "Editing a file";
			case "bash":
				return "Running a command";
			case "grep":
				return typeof a.pattern === "string" ? `Searching ${cutPlainText(a.pattern, 24)}` : "Searching";
			case "find":
			case "ls":
				return "Listing files";
			case "web_search":
				return "Searching the web";
			case "web_fetch":
				return "Fetching a page";
			default:
				return `Running ${toolName}`;
		}
	}
	const line = firstNonEmptyLine(lastText);
	return line ? cutPlainText(line, 48) : "Working…";
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
	private readonly listeners = new Set<(taskId?: string) => void>();

	/**
	 * Add a change listener (widget, view). Each event carries the mutated
	 * run's taskId so a single-run consumer (the transcript view) can ignore
	 * unrelated children's streaming deltas. Returns the unsubscribe.
	 */
	subscribe(cb: (taskId?: string) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private changed(taskId?: string): void {
		for (const cb of this.listeners) cb(taskId);
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
			// The child's prompt opens the transcript, like Claude Code's viewer.
			blocks: input.task.trim() ? [{ kind: "task", text: input.task }] : [],
			baseToolCalls: 0,
			baseTokens: emptyUsage(),
		};
		this.runs.push(run);
		this.byId.set(run.taskId, run);
		this.changed(run.taskId);
	}

	/**
	 * A finished run is being resumed (SendMessage to a done agent): flip it back
	 * to running, restart the clock, and append the new prompt to its transcript.
	 * Returns false when the taskId was never registered (caller registers fresh).
	 */
	reactivate(taskId: string, task: string, startedAt: number): boolean {
		const run = this.byId.get(taskId);
		if (!run) return false;
		run.status = "running";
		run.startedAt = startedAt;
		run.finishedAt = undefined;
		run.activity = "Resuming…";
		// The resumed run's tracker restarts at 0 — bank the lifetime totals so
		// stats() keeps them instead of regressing the displayed cost.
		run.baseToolCalls = run.toolCalls;
		run.baseTokens = { ...run.tokens };
		if (task.trim()) this.block(taskId, { kind: "task", text: task });
		this.changed(taskId);
		return true;
	}

	/** An idle resident got new work — back to running, the turn clock restarts. */
	private wake(run: LiveRun): void {
		if (run.status !== "idle") return;
		run.status = "running";
		run.finishedAt = undefined;
	}

	/** A progress tick from the tracker: refresh tokens/toolCalls (on top of any pre-resume baseline). */
	stats(taskId: string, toolCalls: number, tokens: UsageTotals): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.toolCalls = run.baseToolCalls + toolCalls;
		run.tokens = sumUsage(run.baseTokens, tokens);
		this.wake(run);
		this.changed(taskId);
	}

	/** Update the one-line activity string (already derived). */
	setActivity(taskId: string, activity: string): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.activity = activity;
		this.wake(run);
		this.changed(taskId);
	}

	/** Append a transcript block (bounded). */
	block(taskId: string, block: TranscriptBlock): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.blocks.push(block);
		if (run.blocks.length > MAX_BLOCKS) run.blocks.splice(0, run.blocks.length - MAX_BLOCKS);
		this.changed(taskId);
	}

	/** The in-flight assistant message (or undefined at message_end). O(1) per delta. */
	setStreaming(taskId: string, message: StreamingMessage | undefined): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.streaming = message;
		this.wake(run);
		this.changed(taskId);
	}

	/** A resident agent settled a turn but stays alive — mark idle, keep its totals. */
	settle(taskId: string): void {
		const run = this.byId.get(taskId);
		if (!run || run.status === "done" || run.status === "failed") return;
		run.status = "idle";
		run.activity = "Idle — waiting";
		run.streaming = undefined;
		// The turn is over: freeze the clock and start the strip's linger window
		// (an idle resident leaves the strip like a finished run — it stays
		// reachable via /agents and SendMessage).
		run.finishedAt = Date.now();
		this.changed(taskId);
	}

	/** Terminal: the run finished (or failed). */
	finish(taskId: string, failed: boolean): void {
		const run = this.byId.get(taskId);
		if (!run) return;
		run.status = failed ? "failed" : "done";
		run.finishedAt = Date.now();
		run.activity = failed ? "Failed" : "Completed";
		run.streaming = undefined;
		this.changed(taskId);
	}

	get(taskId: string): LiveRun | undefined {
		return this.byId.get(taskId);
	}

	/** Newest-first, for the strip and viewer (main is prepended by the caller). */
	list(): LiveRun[] {
		return [...this.runs].reverse();
	}
}
