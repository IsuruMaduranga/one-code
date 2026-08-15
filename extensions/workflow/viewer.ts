/**
 * Workflow run viewer (pure): key decoding, phase grouping, the two-level
 * drill-down layout (Phases → agents of a phase → agent detail), and the
 * below-editor status strip — Claude Code's workflow UI, aligned to a frame
 * capture of CC 2.1.233. The thin ctx.ui.custom component in index.ts owns
 * nothing but mutable state, event subscriptions, and repaint calls (same
 * split as plan-mode's viewer).
 *
 * Every rendered line must stay within the width given: pi-tui crashes the
 * whole app on an overwide line. All cells are cut/padded as PLAIN text
 * before painting so ANSI escapes never enter the width accounting.
 */

import { cutPlainText as cut, formatDuration, wrapPlainText } from "../lib/tui-render.ts";
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
	/** Phase titles declared in the script's meta, in declared order. */
	declaredPhases?: string[];
}

/** Mutable viewer state owned by the wiring component. */
export interface ViewerState {
	runIndex: number;
	/** Drill level: the phase list, or the agents of the selected phase. */
	level: "phases" | "agents";
	phaseCursor: number;
	/** Cursor within the selected phase's agents (agents level only). */
	agentCursor: number;
	detailScroll: number;
	promptExpanded: boolean;
	/** Set after `s` hit an existing, different saved file — next `s` overwrites. */
	confirmOverwrite: boolean;
	/** Transient footer message (save confirmation etc.). */
	notice?: string;
}

export function initialViewerState(runIndex = 0): ViewerState {
	return {
		runIndex,
		level: "phases",
		phaseCursor: 0,
		agentCursor: 0,
		detailScroll: 0,
		promptExpanded: false,
		confirmOverwrite: false,
	};
}

export type ViewerKey =
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "pageUp" }
	| { kind: "pageDown" }
	| { kind: "nextRun" }
	| { kind: "enter" }
	| { kind: "back" }
	| { kind: "stop" }
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
		case "\r":
		case "\n":
			return { kind: "enter" };
		case "\x1b":
			return { kind: "back" };
		case "x":
		case "X":
			return { kind: "stop" };
		case "s":
		case "S":
			return { kind: "save" };
		case "q":
		case "\x03": // ctrl+c — close from anywhere, like q
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

/** The strip understands a subset of the viewer's keys, renamed to its intents. */
const STATUS_KEY_FROM_VIEWER: Partial<Record<ViewerKey["kind"], StatusKey>> = {
	up: "up",
	down: "down",
	enter: "open",
	back: "leave",
	stop: "stop",
};

export function decodeStatusKey(data: string): StatusKey | undefined {
	const key = decodeViewerKey(data);
	return key && STATUS_KEY_FROM_VIEWER[key.kind];
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
// Phase grouping
// ---------------------------------------------------------------------------

export interface PhaseGroup {
	title: string;
	/** Whether any agent has run (declared-only phases render dim, countless). */
	started: boolean;
	agents: { record: AgentRecord; agentIndex: number }[];
	done: number;
}

/**
 * Declared phases (script meta) first in declared order, then any phase seen
 * in the event stream that was not declared (child workflows' `▸ name` groups,
 * ad-hoc phase() titles), then a default "agents" group for phaseless agents.
 */
export function buildPhases(run: ViewerRunSnapshot): PhaseGroup[] {
	const groups: PhaseGroup[] = [];
	const byTitle = new Map<string, PhaseGroup>();
	const add = (title: string): PhaseGroup => {
		let group = byTitle.get(title);
		if (!group) {
			group = { title, started: false, agents: [], done: 0 };
			byTitle.set(title, group);
			groups.push(group);
		}
		return group;
	};
	for (const title of run.declaredPhases ?? []) add(title);
	for (const [agentIndex, record] of run.agents.entries()) {
		const group = add(record.phase ?? "agents");
		group.started = true;
		group.agents.push({ record, agentIndex });
		if (record.status !== "running") group.done++;
	}
	return groups;
}

/** Clamp state against the current snapshot (agents appear while live). */
export function clampViewerState(state: ViewerState, runs: ViewerRunSnapshot[]): void {
	state.runIndex = runs.length ? Math.min(state.runIndex, runs.length - 1) : 0;
	const run = runs[state.runIndex];
	const phases = run ? buildPhases(run) : [];
	state.phaseCursor = phases.length ? Math.min(Math.max(0, state.phaseCursor), phases.length - 1) : 0;
	const agents = phases[state.phaseCursor]?.agents.length ?? 0;
	state.agentCursor = agents ? Math.min(Math.max(0, state.agentCursor), agents - 1) : 0;
	if (agents === 0 && state.level === "agents") state.level = "phases";
	if (state.detailScroll < 0) state.detailScroll = 0;
}

// ---------------------------------------------------------------------------
// Formatting helpers (all plain text; painting happens at the very end)
// ---------------------------------------------------------------------------

/** Cut then pad plain text to exactly `width` columns. */
function cell(text: string, width: number): string {
	const shortened = cut(text, width);
	return shortened + " ".repeat(Math.max(0, width - [...shortened].length));
}

/**
 * Split a row into a left half padded against a right-aligned annotation
 * (two-space gap), fusing into one cut line when the left share would drop
 * below readability. The single home of this layout rule — the header, the
 * pane rows, and the status strip all build on it.
 */
function splitRow(left: string, right: string, width: number): { fused: string } | { left: string; right: string } {
	const leftWidth = width - [...right].length - 2;
	if ([...right].length === 0 || leftWidth < 8) return { fused: cut(`${left}  ${right}`.trimEnd(), width) };
	return { left: cell(left, leftWidth), right };
}

/** splitRow flattened to one plain string, exactly `width` wide. */
function splitCell(left: string, right: string, width: number): string {
	const row = splitRow(left, right, width);
	return "fused" in row ? cell(row.fused, width) : `${row.left}  ${row.right}`;
}

const STATUS_MARK: Record<AgentRecord["status"], string> = {
	running: "●",
	done: "✔",
	failed: "✗",
	replayed: "↻",
};

// ---------------------------------------------------------------------------
// Boxed panes
// ---------------------------------------------------------------------------

interface PaneLine {
	text: string;
	style?: "accent" | "dim" | "error" | "bold";
}

/**
 * A bordered pane with a title in the top border, Claude Code style:
 * ┌ Title ────┐ / │ content │ rows / └────┘. `height` includes both borders;
 * content is cut/padded to the inner width before painting.
 */
function boxPane(title: string, lines: PaneLine[], width: number, height: number, paint: ViewerPaint): string[] {
	const innerWidth = Math.max(1, width - 4);
	const contentRows = Math.max(0, height - 2);
	const titleCut = cut(title, Math.max(0, width - 4));
	const dashes = "─".repeat(Math.max(0, width - [...titleCut].length - 4));
	const out: string[] = [paint.fg("dim", "┌ ") + paint.bold(titleCut) + paint.fg("dim", ` ${dashes}┐`)];
	for (let i = 0; i < contentRows; i++) {
		const line = lines[i];
		const plain = cell(line?.text ?? "", innerWidth);
		const painted = !line?.style ? plain : line.style === "bold" ? paint.bold(plain) : paint.fg(line.style, plain);
		out.push(`${paint.fg("dim", "│")} ${painted} ${paint.fg("dim", "│")}`);
	}
	out.push(paint.fg("dim", `└${"─".repeat(Math.max(0, width - 2))}┘`));
	return out;
}

/** Slice rows so the cursor stays visible in a `visible`-row window. */
function scrollWindow<T>(rows: T[], cursor: number, visible: number): T[] {
	let offset = 0;
	if (cursor >= visible) offset = cursor - visible + 1;
	if (rows.length > visible) offset = Math.min(offset, rows.length - visible);
	return rows.slice(offset, offset + visible);
}

// ---------------------------------------------------------------------------
// Pane content builders
// ---------------------------------------------------------------------------

/** Left pane, phases level: `✔ Survey  1/1` / `2 Analyze  0/5` / `3 Synthesize`. */
function phaseRows(phases: PhaseGroup[], cursor: number, innerWidth: number): PaneLine[] {
	return phases.map((phase, index) => {
		const selected = index === cursor;
		const allDone = phase.started && phase.done === phase.agents.length;
		const mark = selected ? "❯" : allDone ? "✔" : String(index + 1);
		const count = phase.started ? `${phase.done}/${phase.agents.length}` : "";
		const text = splitCell(`${mark} ${phase.title}`, count, innerWidth);
		if (selected) return { text, style: "accent" as const };
		return { text, style: phase.started ? undefined : ("dim" as const) };
	});
}

/**
 * Agent rows: `mark label  Model · 31.6k tok` with a right-aligned duration —
 * the non-interactive preview beside the Phases pane (the selectable list at
 * the agents level is agentLabelRows).
 */
function agentRows(agents: PhaseGroup["agents"], innerWidth: number, now: number): PaneLine[] {
	if (!agents.length) return [{ text: "No agents yet — waiting for the first agent() call…", style: "dim" }];
	const labelWidth = Math.min(24, Math.max(10, Math.floor(innerWidth * 0.4)));
	return agents.map(({ record }) => {
		const meta = [record.model, record.tokens ? `${formatTokenCount(record.tokens.output)} tok` : ""]
			.filter(Boolean)
			.join(" · ");
		const left = `  ${STATUS_MARK[record.status]} ${cell(record.label, labelWidth)} ${meta}`;
		const text = splitCell(left, formatDuration(record.startedAt, record.finishedAt, now), innerWidth);
		return { text, style: record.status === "failed" ? ("error" as const) : undefined };
	});
}

const STATUS_TITLE: Record<AgentRecord["status"], string> = {
	running: "● Running",
	done: "✔ Completed",
	failed: "✗ Failed",
	replayed: "↻ Replayed (cached)",
};

/** How many wrapped prompt lines show before `⏎ expand` kicks in. */
export const PROMPT_PREVIEW_LINES = 3;
/** How many trailing tool calls the Activity section shows. */
export const ACTIVITY_TAIL = 3;

/** Right pane, agents level: the full agent detail. */
export function buildDetail(
	record: AgentRecord | undefined,
	width: number,
	now: number,
	promptExpanded: boolean,
): PaneLine[] {
	if (!record) return [{ text: "No agents yet — waiting for the first agent() call…", style: "dim" }];
	const lines: PaneLine[] = [];
	const title = STATUS_TITLE[record.status] + (record.model ? ` · ${record.model}` : "");
	lines.push({ text: title, style: record.status === "failed" ? "error" : "accent" });
	const toolCalls = record.toolCalls ?? record.activity.length;
	const stats: string[] = [];
	if (record.tokens) stats.push(`${formatTokenCount(record.tokens.output)} tok`);
	stats.push(`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
	const duration = formatDuration(record.startedAt, record.finishedAt, now);
	if (duration) stats.push(duration);
	if (record.cost) stats.push(`$${record.cost.toFixed(4)}`);
	lines.push({ text: stats.join(" · "), style: "dim" });

	const section = (header: string, body: string[], bodyStyle?: PaneLine["style"]) => {
		lines.push({ text: "" });
		lines.push({ text: header, style: "bold" });
		for (const text of body) lines.push({ text: `  ${text}`, style: bodyStyle });
	};

	const promptLines = record.prompt ? wrapPlainText(record.prompt, width - 2) : ["(not recorded)"];
	if (promptLines.length > PROMPT_PREVIEW_LINES && !promptExpanded) {
		const hidden = promptLines.length - PROMPT_PREVIEW_LINES;
		section("Prompt", [
			...promptLines.slice(0, PROMPT_PREVIEW_LINES),
			`… +${hidden} more line${hidden === 1 ? "" : "s"} (⏎ to expand)`,
		]);
	} else {
		section("Prompt", promptLines);
	}

	const tail = record.activity.slice(-ACTIVITY_TAIL);
	const activityHeader =
		toolCalls > tail.length ? `Activity · last ${tail.length} of ${toolCalls} tool calls` : "Activity";
	section(
		activityHeader,
		tail.length
			? tail.map((tool) => cut(`${tool.name}(${tool.argsSummary ?? ""})`, width - 2))
			: [record.status === "replayed" ? "(replayed — activity not recorded)" : "No tool calls."],
		tail.length ? undefined : "dim",
	);

	if (record.status === "failed") {
		section("Error", wrapPlainText(record.error ?? "unknown", width - 2), "error");
	} else {
		section("Outcome", record.outcome ? wrapPlainText(record.outcome, width - 2) : ["Still running…"], record.outcome ? undefined : "dim");
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
			paint.fg("dim", cut('Start one with the workflow tool (or say "ultracode"). esc close', width)),
			"",
		];
	}
	clampViewerState(state, runs);
	const run = runs[state.runIndex];
	const phases = buildPhases(run);
	const phase = phases[state.phaseCursor];

	const out: string[] = [];

	// Header: name + right-aligned stats; description (+ run cycle hint) below.
	const doneCount = run.agents.filter((a) => a.status !== "running").length;
	const stats = [
		`${doneCount}/${run.agents.length} agents`,
		formatDuration(run.startedAt, run.finishedAt, input.now),
		run.status === "running" ? "" : run.status,
	]
		.filter(Boolean)
		.join(" · ");
	const headerLine = (left: string, leftColor: string, right: string): string => {
		const row = splitRow(left, right, width);
		if ("fused" in row) return paint.fg(leftColor, row.fused);
		return paint.fg(leftColor, row.left) + "  " + paint.fg("dim", row.right);
	};
	out.push(headerLine(run.name, "accent", stats));
	const runHint = runs.length > 1 ? `run ${state.runIndex + 1}/${runs.length} (tab)` : run.runId;
	out.push(headerLine(run.description ?? "", "dim", runHint));
	if (run.errorMessage && run.status !== "completed") {
		out.push(paint.fg("error", cut(`⚠ ${run.errorMessage}`, width)));
	}

	// Body: two boxed panes, side by side (or stacked when narrow).
	const footerRows = 1;
	const bodyHeight = Math.max(6, input.height - out.length - footerRows);
	const atAgents = state.level === "agents" && phase && phase.agents.length > 0;

	const agentCountTitle = phase
		? `${phase.title} · ${phase.agents.length} agent${phase.agents.length === 1 ? "" : "s"}`
		: "agents";
	const leftTitle = atAgents ? agentCountTitle : "Phases";
	const rightTitle = atAgents ? (phase.agents[state.agentCursor]?.record.label ?? "agent") : agentCountTitle;
	const leftWidthWanted = atAgents ? 32 : 26;
	const leftRowCount = atAgents ? phase.agents.length : phases.length;

	// Pane content is built once, at the real inner widths of whichever layout runs.
	const buildPanes = (leftInner: number, rightInner: number, leftVisible: number, rightVisible: number) => {
		if (!atAgents) {
			return {
				left: scrollWindow(phaseRows(phases, state.phaseCursor, leftInner), state.phaseCursor, leftVisible),
				right: phase ? agentRows(phase.agents, rightInner, input.now).slice(0, rightVisible) : [],
			};
		}
		return {
			left: scrollWindow(agentLabelRows(phase.agents, state.agentCursor), state.agentCursor, leftVisible),
			right: detailWindow(
				buildDetail(phase.agents[state.agentCursor]?.record, rightInner, input.now, state.promptExpanded),
				state,
				rightVisible,
				rightInner,
			),
		};
	};

	if (width >= MIN_TWO_PANE_WIDTH) {
		const leftWidth = Math.min(leftWidthWanted, Math.max(18, Math.floor(width * 0.25)));
		const rightWidth = width - leftWidth - 1;
		const visible = bodyHeight - 2;
		const panes = buildPanes(leftWidth - 4, rightWidth - 4, visible, visible);
		const left = boxPane(leftTitle, panes.left, leftWidth, bodyHeight, paint);
		const right = boxPane(rightTitle, panes.right, rightWidth, bodyHeight, paint);
		for (let i = 0; i < bodyHeight; i++) out.push(`${left[i]} ${right[i]}`);
	} else {
		// Narrow: stack the two panes.
		const leftHeight = Math.max(4, Math.min(leftRowCount + 2, Math.floor(bodyHeight / 2)));
		const rightHeight = bodyHeight - leftHeight;
		const inner = width - 4;
		const panes = buildPanes(inner, inner, leftHeight - 2, rightHeight - 2);
		out.push(...boxPane(leftTitle, panes.left, width, leftHeight, paint));
		out.push(...boxPane(rightTitle, panes.right, width, rightHeight, paint));
	}

	// Footer: per-level key hints, replaced by a transient notice when set.
	const stopHint = run.status === "running" ? "x stop workflow · " : "";
	const hints = !atAgents
		? `↑↓ select · ⏎ open · ${runs.length > 1 ? "tab run · " : ""}${stopHint}s save · esc close`
		: `↑↓ agent · ⏎ prompt · pgup/pgdn scroll · ${stopHint}s save · esc back`;
	out.push(paint.fg("dim", cut(state.notice ?? hints, width)));
	return out;
}

/** Left pane, agents level: mark + label rows with the ❯ cursor. */
function agentLabelRows(agents: PhaseGroup["agents"], cursor: number): PaneLine[] {
	return agents.map(({ record }, index) => {
		const selected = index === cursor;
		const text = `${selected ? "❯" : " "} ${STATUS_MARK[record.status]} ${record.label}`;
		if (selected) return { text, style: "accent" as const };
		return { text, style: record.status === "failed" ? ("error" as const) : undefined };
	});
}

/** Apply detailScroll with clamping and a `lines X–Y of N` trailer when cut. */
function detailWindow(detail: PaneLine[], state: ViewerState, visible: number, innerWidth: number): PaneLine[] {
	state.detailScroll = Math.max(0, Math.min(state.detailScroll, Math.max(0, detail.length - visible)));
	const window = detail.slice(state.detailScroll, state.detailScroll + visible);
	if (detail.length > visible) {
		const last = Math.min(detail.length, state.detailScroll + visible);
		if (window.length === visible) window.pop();
		window.push({
			text: cut(`lines ${state.detailScroll + 1}–${last} of ${detail.length}`, innerWidth),
			style: "dim",
		});
	}
	return window;
}

// ---------------------------------------------------------------------------
// Status strip (the persistent below-editor rows, Claude Code's bottom entry)
// ---------------------------------------------------------------------------

export interface StatusRowsInput {
	/** The runs that can appear (newest first) — callers may pass just the visible slice. */
	runs: ViewerRunSnapshot[];
	/** Session-wide run count behind the "+N more" line; defaults to runs.length. */
	totalRuns?: number;
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
		const row = splitRow(left, stats, width);
		if (selected) {
			out.push(paint.fg("accent", "fused" in row ? row.fused : `${row.left}  ${row.right}`));
		} else if ("fused" in row) {
			out.push(paint.fg(run.status === "failed" ? "error" : "dim", row.fused));
		} else {
			const leftPart = run.status === "failed" ? paint.fg("error", row.left) : row.left;
			out.push(`${leftPart}  ${paint.fg("dim", row.right)}`);
		}
	}
	const total = input.totalRuns ?? input.runs.length;
	if (total > shown.length) {
		out.push(paint.fg("dim", cut(`  +${total - shown.length} more — /workflows`, width)));
	}
	return out;
}
