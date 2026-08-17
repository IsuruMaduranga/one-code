/**
 * Pure rendering for the subagent panel — Claude Code's below-editor agent tree
 * and its Enter-to-view child transcript. All lines are cut/padded as PLAIN
 * text before painting so ANSI escapes never enter width accounting (pi-tui
 * crashes on an overwide line). Wiring (widget + ctx.ui.custom) lives in
 * index.ts; this file owns layout only, mirroring workflow/viewer.ts.
 */

import { cutPlainText as cut, formatDuration, padPlainText } from "../lib/tui-render.ts";
import { formatTokenCount } from "./usage.ts";
import type { LiveRun, LiveStatus, TranscriptBlock } from "./live-runs.ts";

export interface Paint {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** A strip row: main is row 0 (synthetic), then the live children. */
export interface PanelRow {
	/** undefined = the synthetic `main` row. */
	run?: LiveRun;
	label: string;
	activity: string;
	status: LiveStatus;
	startedAt?: number;
	finishedAt?: number;
	tokens: number;
}

/** Build the row list: `main` first, then newest-first children. `mainBusy` drives main's dot. */
export function buildRows(runs: LiveRun[], mainBusy: boolean): PanelRow[] {
	const main: PanelRow = {
		label: "main",
		activity: "",
		status: mainBusy ? "running" : "idle",
		tokens: 0,
	};
	const children = runs.map((run) => ({
		run,
		label: run.agentType,
		activity: run.activity,
		status: run.status,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		tokens: run.tokens.output,
	}));
	return [main, ...children];
}

const cell = padPlainText;

/** Left half padded against a right-aligned annotation, fusing when the left share is too small. */
function splitCell(left: string, right: string, width: number): string {
	const leftWidth = width - [...right].length - 2;
	if ([...right].length === 0 || leftWidth < 8) return cell(`${left}  ${right}`.trimEnd(), width);
	return `${cell(left, leftWidth)}  ${right}`;
}

const STATUS_ROW_STYLE: Partial<Record<LiveStatus, string>> = { failed: "error" };

// ---------------------------------------------------------------------------
// The strip (below-editor, always-on while agents are alive)
// ---------------------------------------------------------------------------

export const MAX_STRIP_ROWS = 6;

export interface StripInput {
	rows: PanelRow[];
	/** Soft-focused row index; undefined when the strip is not focused. */
	selected?: number;
	width: number;
	now: number;
}

/**
 * One line per row: `mark  agentType  activity   elapsed · ↓ tokens`. The
 * selected row is bold and `●`; others `○`. A focus hint precedes the list
 * (only while focused). Overflow past MAX_STRIP_ROWS collapses to "+N more".
 */
export function renderStrip(input: StripInput, paint: Paint): string[] {
	const width = Math.max(20, input.width);
	const out: string[] = [];
	if (input.selected !== undefined) {
		out.push(paint.fg("dim", cut("↑/↓ to select · ⏎ view · esc back", width)));
	}
	const shown = input.rows.slice(0, MAX_STRIP_ROWS);
	for (const [index, row] of shown.entries()) {
		const selected = input.selected === index;
		const mark = selected ? "●" : "○";
		const stats = [
			formatDuration(row.startedAt, row.finishedAt, input.now),
			row.tokens ? `↓ ${formatTokenCount(row.tokens)} tokens` : "",
		]
			.filter(Boolean)
			.join(" · ");
		const left = `${mark} ${row.label}${row.activity ? `  ${row.activity}` : ""}`;
		const line = splitCell(left, stats, width);
		if (selected) out.push(paint.fg("accent", paint.bold(line)));
		else if (STATUS_ROW_STYLE[row.status]) out.push(paint.fg(STATUS_ROW_STYLE[row.status]!, line));
		else out.push(row.run ? line : paint.fg("dim", line));
	}
	if (input.rows.length > shown.length) {
		out.push(paint.fg("dim", cut(`  +${input.rows.length - shown.length} more — /agents`, width)));
	}
	return out;
}

// ---------------------------------------------------------------------------
// The child transcript viewer (Enter-to-view)
// ---------------------------------------------------------------------------

const SPINNER_VERBS = ["Working", "Moseying", "Gusting", "Scampering", "Percolating", "Noodling", "Puttering", "Simmering"];

/** A stable-ish live verb: cycles by elapsed seconds so it animates without Math.random. */
export function spinnerVerb(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	return SPINNER_VERBS[Math.floor(seconds / 3) % SPINNER_VERBS.length];
}

const BLOCK_MARK: Record<TranscriptBlock["kind"], string> = { text: "", call: "●", result: "⎿" };

export interface TranscriptInput {
	run: LiveRun;
	width: number;
	height: number;
	scroll: number;
	now: number;
}

/**
 * The full child session, Claude Code's Enter-to-view: a synthesized identity
 * header, the transcript blocks (scrollable), and a live spinner while running.
 * Returns painted lines already cut to width.
 */
export function renderTranscript(input: TranscriptInput, paint: Paint): string[] {
	const { run } = input;
	const width = Math.max(20, input.width);
	const out: string[] = [];

	// Header: name + label chip, then identity, then a stats line.
	out.push(splitPaint(paint, "accent", run.name, chip(run.label), width, paint.bold));
	const identity = [run.agentType, run.model, run.thinking ? `${run.thinking} effort` : ""].filter(Boolean).join(" · ");
	out.push(paint.fg("dim", cut(identity, width)));
	const stats = [
		`${run.toolCalls} tool call${run.toolCalls === 1 ? "" : "s"}`,
		run.tokens.output ? `↓ ${formatTokenCount(run.tokens.output)} tokens` : "",
		formatDuration(run.startedAt, run.finishedAt, input.now),
	]
		.filter(Boolean)
		.join(" · ");
	out.push(paint.fg("dim", cut(stats, width)));
	out.push("");

	// Body: the transcript blocks, scrolled to a window that leaves room for the
	// header already emitted plus the spinner + footer below. Text blocks are
	// plain; call/result carry their mark. No fill-padding — the footer must stay
	// on-screen even when the overlay is short.
	const bodyRows = Math.max(3, input.height - out.length - 2);
	const blockLines = run.blocks.map((block) => paintBlock(block, width, paint));
	const start = Math.max(0, Math.min(input.scroll, Math.max(0, blockLines.length - bodyRows)));
	const window = blockLines.slice(start, start + bodyRows);
	for (const line of window) out.push(line);

	// Spinner (running) or a terminal line, then the footer hint.
	if (run.status === "running") {
		const verb = spinnerVerb(run.startedAt, input.now);
		const spin = `${verb}… (${formatDuration(run.startedAt, undefined, input.now)}${
			run.tokens.output ? ` · ↓ ${formatTokenCount(run.tokens.output)} tokens` : ""
		}${run.thinking ? ` · thinking with ${run.thinking} effort` : ""})`;
		out.push(paint.fg("accent", cut(spin, width)));
	} else {
		const done =
			run.status === "failed" ? paint.fg("error", "✗ Failed") : run.status === "idle" ? paint.fg("dim", "Idle — resident") : paint.fg("dim", "✔ Completed");
		out.push(cut(done, width));
	}
	out.push(paint.fg("dim", cut("↑/↓ scroll · tab next agent · x stop · ctrl+x ctrl+k stop all · esc back", width)));
	return out;
}

function paintBlock(block: TranscriptBlock, width: number, paint: Paint): string {
	const mark = BLOCK_MARK[block.kind];
	if (block.kind === "text") return cut(block.text, width);
	if (block.kind === "call") return `${paint.fg("accent", mark)} ${cut(`${block.tool}(${block.text})`, width - 2)}`;
	const body = cut(block.text, width - 2);
	return `  ${paint.fg("dim", mark)} ${block.isError ? paint.fg("error", body) : body}`;
}

/** A small inverse-video chip for the label, degrading to `[label]` when narrow. */
function chip(label: string): string {
	return label ? ` ${label} ` : "";
}

/** Header row: left name + right-aligned chip, painted, fused when narrow. */
function splitPaint(
	paint: Paint,
	leftColor: string,
	left: string,
	right: string,
	width: number,
	boldLeft?: (t: string) => string,
): string {
	const leftWidth = width - [...right].length - 2;
	if ([...right].length === 0 || leftWidth < 8) {
		const line = cut(left, width);
		return paint.fg(leftColor, boldLeft ? boldLeft(line) : line);
	}
	const l = padPlainText(left, leftWidth);
	return `${paint.fg(leftColor, boldLeft ? boldLeft(l) : l)}  ${paint.fg("accent", paint.bold(right))}`;
}
