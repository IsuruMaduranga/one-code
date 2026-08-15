/**
 * Workflow run viewer (pure): key decoding, tree building, two-pane layout,
 * and rendering for the interactive /workflows screen — Claude Code's
 * workflow UI. The thin ctx.ui.custom component in index.ts owns nothing but
 * mutable state, event subscriptions, and repaint calls (same split as
 * plan-mode's viewer).
 *
 * Every rendered line must stay within the width given: pi-tui crashes the
 * whole app on an overwide line. All cells are cut/padded as PLAIN text
 * before painting so ANSI escapes never enter the width accounting.
 */

import { cutPlainText as cut, wrapPlainText } from "../lib/tui-render.ts";
import { formatTokenCount } from "../subagents/usage.ts";
import type { AgentRecord, RunStatus } from "./types.ts";

/** Theme access the renderer needs: fg tokens ("accent", "dim", "error", …) and bold. */
export interface ViewerPaint {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Immutable snapshot of one run, built from RunHandle each render. */
export interface ViewerRunSnapshot {
	runId: string;
	name: string;
	description?: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	errorMessage?: string;
	agents: AgentRecord[];
}

/** Mutable viewer state owned by the wiring component. */
export interface ViewerState {
	runIndex: number;
	cursor: number;
	detailScroll: number;
	/** Set after `s` hit an existing, different saved file — next `s` overwrites. */
	confirmOverwrite: boolean;
	/** Transient footer message (save confirmation etc.). */
	notice?: string;
}

export function initialViewerState(runIndex = 0): ViewerState {
	return { runIndex, cursor: 0, detailScroll: 0, confirmOverwrite: false };
}

export type ViewerKey =
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "pageUp" }
	| { kind: "pageDown" }
	| { kind: "nextRun" }
	| { kind: "save" }
	| { kind: "close" };

export function decodeViewerKey(data: string): ViewerKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
			return { kind: "down" };
		case "\x1b[5~":
			return { kind: "pageUp" };
		case "\x1b[6~":
			return { kind: "pageDown" };
		case "\t":
			return { kind: "nextRun" };
		case "s":
		case "S":
			return { kind: "save" };
		case "\x1b":
		case "\x03": // ctrl+c — same intent as escape while the viewer is focused
		case "q":
			return { kind: "close" };
		default:
			return undefined;
	}
}

/**
 * Keys the below-editor status strip responds to while it holds soft focus
 * (Claude Code's down-arrow-to-the-workflow-entry flow). Anything it does not
 * recognize means the user started typing — the wiring drops focus and lets
 * the byte through to the editor.
 */
export type StatusKey = "up" | "down" | "open" | "leave" | "stop";

export function decodeStatusKey(data: string): StatusKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
			return "up";
		case "\x1b[B":
		case "\x1bOB":
			return "down";
		case "\r":
		case "\n":
			return "open";
		case "\x1b":
			return "leave";
		case "x":
		case "X":
			return "stop";
		default:
			return undefined;
	}
}

/** Clamp state against the current snapshot (agents appear while live). */
export function clampViewerState(state: ViewerState, runs: ViewerRunSnapshot[]): void {
	state.runIndex = runs.length ? Math.min(state.runIndex, runs.length - 1) : 0;
	const agents = runs[state.runIndex]?.agents.length ?? 0;
	state.cursor = agents ? Math.min(Math.max(0, state.cursor), agents - 1) : 0;
	if (state.detailScroll < 0) state.detailScroll = 0;
}

/** What pressing `s` should do, given what's on disk. Wiring does the fs. */
export function planSave(input: {
	name: string;
	exists: boolean;
	sameContent: boolean;
	confirmed: boolean;
}): { action: "write" | "confirm" | "noop"; notice: string } {
	const target = `.claude/workflows/${input.name}.js`;
	if (!input.exists || input.sameContent) return { action: "write", notice: `saved to ${target}` };
	if (input.confirmed) return { action: "write", notice: `overwrote ${target}` };
	return { action: "confirm", notice: `${target} exists and differs — press s again to overwrite` };
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface TreeRow {
	kind: "phase" | "agent";
	text: string;
	/** Index into the run's agents array (agent rows only). */
	agentIndex?: number;
	status?: AgentRecord["status"];
}

const STATUS_MARK: Record<AgentRecord["status"], string> = {
	running: "⏳",
	done: "✔",
	failed: "✗",
	replayed: "↻",
};

/** Group agents by phase in first-appearance order. */
export function buildTree(agents: AgentRecord[]): TreeRow[] {
	const rows: TreeRow[] = [];
	const phaseAt = new Map<string, number>(); // phase → index of its header row
	const counts = new Map<string, number>();
	for (const [agentIndex, record] of agents.entries()) {
		const phase = record.phase ?? "agents";
		if (!phaseAt.has(phase)) {
			phaseAt.set(phase, rows.length);
			rows.push({ kind: "phase", text: phase });
		}
		counts.set(phase, (counts.get(phase) ?? 0) + 1);
		rows.push({
			kind: "agent",
			text: record.label,
			agentIndex,
			status: record.status,
		});
	}
	// Stamp each phase header with its agent count now that groups are complete.
	for (const [phase, rowIndex] of phaseAt) {
		const count = counts.get(phase) ?? 0;
		rows[rowIndex].text = `${phase} · ${count} agent${count === 1 ? "" : "s"}`;
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Formatting helpers (all plain text; painting happens at the very end)
// ---------------------------------------------------------------------------

function formatDuration(startedAt?: number, finishedAt?: number, now?: number): string {
	if (startedAt === undefined) return "";
	const end = finishedAt ?? now ?? startedAt;
	return `${Math.max(0, Math.round((end - startedAt) / 1000))}s`;
}

/** Cut then pad plain text to exactly `width` columns. */
function cell(text: string, width: number): string {
	const shortened = cut(text, width);
	return shortened + " ".repeat(Math.max(0, width - [...shortened].length));
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

interface DetailLine {
	text: string;
	style?: "accent" | "dim" | "error" | "bold";
}

const STATUS_TITLE: Record<AgentRecord["status"], string> = {
	running: "⏳ Running",
	done: "✔ Completed",
	failed: "✗ Failed",
	replayed: "↻ Replayed (cached)",
};

export function buildDetail(record: AgentRecord | undefined, width: number, now: number): DetailLine[] {
	if (!record) return [{ text: "No agents yet — waiting for the first agent() call…", style: "dim" }];
	const lines: DetailLine[] = [];
	const title = STATUS_TITLE[record.status] + (record.model ? ` · ${record.model}` : "");
	lines.push({ text: title, style: record.status === "failed" ? "error" : "accent" });
	const stats: string[] = [];
	if (record.tokens) stats.push(`${formatTokenCount(record.tokens.output)} out-tok`);
	const duration = formatDuration(record.startedAt, record.finishedAt, now);
	if (duration) stats.push(duration);
	if (record.cost) stats.push(`$${record.cost.toFixed(4)}`);
	if (stats.length) lines.push({ text: stats.join(" · "), style: "dim" });

	const section = (header: string, body: string[], bodyStyle?: DetailLine["style"]) => {
		lines.push({ text: "" });
		lines.push({ text: header, style: "bold" });
		for (const text of body) lines.push({ text: `  ${text}`, style: bodyStyle });
	};

	section("Prompt", record.prompt ? wrapPlainText(record.prompt, width - 2) : ["(not recorded)"]);
	section(
		"Activity",
		record.activity.length
			? record.activity.map((tool) => cut(`${tool.name}(${tool.argsSummary ?? ""})`, width - 2))
			: [record.status === "replayed" ? "(replayed — activity not recorded)" : "No tool calls."],
		record.activity.length ? undefined : "dim",
	);
	if (record.status === "failed") {
		section("Error", wrapPlainText(record.error ?? "unknown", width - 2), "error");
	} else {
		section("Outcome", record.outcome ? wrapPlainText(record.outcome, width - 2) : ["(pending)"]);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface ViewerInput {
	runs: ViewerRunSnapshot[];
	state: ViewerState;
	width: number;
	height: number;
	now: number;
}

const MIN_TWO_PANE_WIDTH = 70;

export function renderViewer(input: ViewerInput, paint: ViewerPaint): string[] {
	const { runs, state } = input;
	const width = Math.max(20, input.width);
	if (!runs.length) {
		return [
			"",
			paint.fg("accent", cut("No workflow runs this session.", width)),
			paint.fg("dim", cut("Start one with the workflow tool (or say \"ultracode\"). esc close", width)),
			"",
		];
	}
	clampViewerState(state, runs);
	const run = runs[state.runIndex];
	const tree = buildTree(run.agents);
	const cursorRecord = run.agents[state.cursor];

	const out: string[] = [];

	// Header: name + right-aligned stats; description (+ run cycle hint) below.
	const doneCount = run.agents.filter((a) => a.status !== "running").length;
	const stats = [
		`${doneCount}/${run.agents.length} agents`,
		formatDuration(run.startedAt, run.finishedAt, input.now),
		run.status,
	]
		.filter(Boolean)
		.join(" · ");
	// Left text + right-aligned annotation, degrading to left-only when the
	// annotation would squeeze the text below readability.
	const headerLine = (left: string, leftColor: string, right: string): string => {
		const leftWidth = width - [...right].length - 2;
		if (leftWidth < 8) return paint.fg(leftColor, cut(`${left}  ${right}`, width));
		return paint.fg(leftColor, cell(left, leftWidth)) + "  " + paint.fg("dim", right);
	};
	out.push(headerLine(run.name, "accent", stats));
	const runHint = runs.length > 1 ? `run ${state.runIndex + 1}/${runs.length} (tab)` : run.runId;
	out.push(headerLine(run.description ?? "", "dim", runHint));
	if (run.errorMessage && run.status !== "completed") {
		out.push(paint.fg("error", cut(`⚠ ${run.errorMessage}`, width)));
	}

	// Body: tree + detail, side by side or stacked.
	const footerRows = 1;
	const bodyHeight = Math.max(6, input.height - out.length - footerRows);
	const paintTreeRow = (row: TreeRow, selected: boolean, paneWidth: number): string => {
		if (row.kind === "phase") return paint.fg("dim", cell(`─ ${row.text}`, paneWidth));
		const mark = row.status ? STATUS_MARK[row.status] : " ";
		const plain = cell(`${selected ? "❯" : " "} ${mark} ${row.text}`, paneWidth);
		if (selected) return paint.fg("accent", plain);
		return row.status === "failed" ? paint.fg("error", plain) : plain;
	};

	if (width >= MIN_TWO_PANE_WIDTH) {
		const treeWidth = Math.min(32, Math.max(20, Math.floor(width * 0.3)));
		const detailWidth = width - treeWidth - 3; // " │ " separator
		const treeLines = paneLines(tree, state, bodyHeight, treeWidth, paintTreeRow);
		const detail = buildDetail(cursorRecord, detailWidth, input.now);
		const detailLines = detailPane(detail, state, bodyHeight, detailWidth, paint);
		for (let i = 0; i < bodyHeight; i++) {
			const left = treeLines[i] ?? " ".repeat(treeWidth);
			const right = detailLines[i] ?? "";
			out.push(`${left} ${paint.fg("dim", "│")} ${right}`);
		}
	} else {
		const treeHeight = Math.max(3, Math.min(tree.length, Math.floor(bodyHeight / 2)));
		const detailHeight = bodyHeight - treeHeight - 1;
		out.push(...paneLines(tree, state, treeHeight, width, paintTreeRow));
		out.push(paint.fg("dim", "─".repeat(Math.min(width, 72))));
		const detail = buildDetail(cursorRecord, width, input.now);
		out.push(...detailPane(detail, state, Math.max(3, detailHeight), width, paint));
	}

	// Footer: key hints, replaced by a transient notice when set.
	const hints = "↑↓ agent · pgup/pgdn scroll · " + (runs.length > 1 ? "tab run · " : "") + "s save · esc close";
	out.push(paint.fg("dim", cut(state.notice ?? hints, width)));
	return out;
}

/** Slice the tree so the cursor's row stays visible; pad to `height` lines. */
function paneLines(
	tree: TreeRow[],
	state: ViewerState,
	height: number,
	paneWidth: number,
	paintRow: (row: TreeRow, selected: boolean, paneWidth: number) => string,
): string[] {
	const cursorRow = tree.findIndex((row) => row.agentIndex === state.cursor);
	let offset = 0;
	if (cursorRow >= 0 && cursorRow >= height) offset = cursorRow - height + 1;
	if (tree.length > height) offset = Math.min(offset, tree.length - height);
	const visible = tree.slice(offset, offset + height);
	const lines = visible.map((row) => paintRow(row, row.agentIndex === state.cursor, paneWidth));
	while (lines.length < height) lines.push(" ".repeat(paneWidth));
	return lines;
}

// ---------------------------------------------------------------------------
// Status strip (the persistent below-editor rows, Claude Code's bottom entry)
// ---------------------------------------------------------------------------

export interface StatusRowsInput {
	runs: ViewerRunSnapshot[];
	/** Index into `runs` of the soft-focused row; undefined when unfocused. */
	selected?: number;
	width: number;
	now: number;
}

/** Rows shown before collapsing the rest into a "+N more" line. */
export const MAX_STATUS_ROWS = 3;

const STATUS_ROW_MARK: Record<RunStatus, string> = {
	running: "○",
	completed: "●",
	failed: "✗",
	aborted: "◼",
};

/**
 * One line per run: marker + name + description on the left, right-aligned
 * `done/total agents done · elapsed · ↓ tokens` stats. The soft-focused row
 * swaps its marker for ❯ and is painted accent by the caller's palette.
 */
export function renderStatusRows(input: StatusRowsInput, paint: ViewerPaint): string[] {
	const width = Math.max(20, input.width);
	if (!input.runs.length) return [];
	const out: string[] = [];
	const shown = input.runs.slice(0, MAX_STATUS_ROWS);
	for (const [index, run] of shown.entries()) {
		const selected = input.selected === index;
		const done = run.agents.filter((a) => a.status !== "running").length;
		const outTokens = run.agents.reduce((sum, a) => sum + (a.tokens?.output ?? 0), 0);
		const stats = [
			`${done}/${run.agents.length} agents done`,
			formatDuration(run.startedAt, run.finishedAt, input.now),
			outTokens ? `↓ ${formatTokenCount(outTokens)} tokens` : "",
			run.status === "running" || run.status === "completed" ? "" : run.status,
		]
			.filter(Boolean)
			.join(" · ");
		const mark = selected ? "❯" : STATUS_ROW_MARK[run.status];
		const left = `${mark} ${run.name}  ${run.description ?? ""}`.trimEnd();
		const leftWidth = width - [...stats].length - 2;
		if (selected) {
			const plain = leftWidth < 8 ? cut(`${left}  ${stats}`, width) : `${cell(left, leftWidth)}  ${stats}`;
			out.push(paint.fg("accent", plain));
		} else if (leftWidth < 8) {
			const color = run.status === "failed" ? "error" : "dim";
			out.push(paint.fg(color, cut(`${left}  ${stats}`, width)));
		} else {
			const leftPart = run.status === "failed" ? paint.fg("error", cell(left, leftWidth)) : cell(left, leftWidth);
			out.push(`${leftPart}  ${paint.fg("dim", stats)}`);
		}
	}
	if (input.runs.length > shown.length) {
		out.push(paint.fg("dim", cut(`  +${input.runs.length - shown.length} more — /workflows`, width)));
	}
	return out;
}

function detailPane(
	detail: DetailLine[],
	state: ViewerState,
	height: number,
	paneWidth: number,
	paint: ViewerPaint,
): string[] {
	state.detailScroll = Math.max(0, Math.min(state.detailScroll, Math.max(0, detail.length - height)));
	const visible = detail.slice(state.detailScroll, state.detailScroll + height);
	const lines = visible.map((line) => {
		const plain = cut(line.text, paneWidth);
		if (!line.style) return plain;
		return line.style === "bold" ? paint.bold(plain) : paint.fg(line.style, plain);
	});
	if (detail.length > height) {
		const last = Math.min(detail.length, state.detailScroll + height);
		if (lines.length === height) lines.pop();
		lines.push(paint.fg("dim", cut(`lines ${state.detailScroll + 1}–${last} of ${detail.length}`, paneWidth)));
	}
	return lines;
}
