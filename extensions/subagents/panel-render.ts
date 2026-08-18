/**
 * Pure rendering for the subagent panel — Claude Code's below-editor agent tree
 * and its Enter-to-view child transcript. All lines are cut/padded as PLAIN
 * text before painting so ANSI escapes never enter width accounting (pi-tui
 * crashes on an overwide line). Wiring (widget + ctx.ui.custom) lives in
 * index.ts; this file owns layout only, mirroring workflow/viewer.ts.
 */

import { cutPlainText as cut, formatDuration, splitCell, splitRow } from "../lib/tui-render.ts";
import { formatTokenCount } from "./usage.ts";
import { type LiveRun, type LiveStatus, streamingText, type TranscriptBlock } from "./live-runs.ts";

export interface Paint {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** A strip row: main is row 0 (synthetic), then the live children as a tree. */
export interface PanelRow {
	/** undefined = the synthetic `main` row. */
	run?: LiveRun;
	label: string;
	activity: string;
	status: LiveStatus;
	startedAt?: number;
	finishedAt?: number;
	tokens: number;
	/** Tree indent: 0 = spawned by main; 1+ = nested under the row above (CC's `└`). */
	depth: number;
}

/**
 * A finished run stays in the strip this long (its "Completed"/"Failed" beat),
 * then drops out — Claude Code's tree only tracks live work. The run itself
 * stays in the registry: the viewer, /agents, and SendMessage still reach it.
 */
export const STRIP_LINGER_MS = 5000;

/**
 * Build the row list: `main` first, then the live children as a TREE — roots
 * newest-first, each root followed by its nested spawns (a child's own Agent
 * calls) in spawn order, indented one level (CC's `└` rows). `mainBusy` drives
 * main's dot. Running children always show; settled ones — done, failed, or an
 * idle resident whose turn ended — only within STRIP_LINGER_MS of finishing
 * (finishedAt is stamped by finish() AND settle()). A nested run whose parent
 * already left the strip surfaces at root level rather than vanishing.
 */
export function buildRows(runs: LiveRun[], mainBusy: boolean, now: number): PanelRow[] {
	const rows: PanelRow[] = [
		{
			label: "main",
			activity: "",
			status: mainBusy ? "running" : "idle",
			tokens: 0,
			depth: 0,
		},
	];
	// `runs` arrives newest-first; children under a parent read best in spawn order.
	const visible = runs.filter((run) => run.status === "running" || (run.finishedAt ?? now) > now - STRIP_LINGER_MS);
	const visibleIds = new Set(visible.map((run) => run.taskId));
	const byParent = new Map<string, LiveRun[]>();
	const roots: LiveRun[] = [];
	for (const run of visible) {
		if (run.parentTaskId && visibleIds.has(run.parentTaskId)) {
			const siblings = byParent.get(run.parentTaskId) ?? [];
			siblings.unshift(run); // reverse the newest-first order → spawn order
			byParent.set(run.parentTaskId, siblings);
		} else {
			roots.push(run);
		}
	}
	const emit = (run: LiveRun, depth: number) => {
		rows.push({
			run,
			label: run.agentType,
			activity: run.activity,
			status: run.status,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			tokens: run.tokens.output,
			depth,
		});
		for (const child of byParent.get(run.taskId) ?? []) emit(child, depth + 1);
	};
	for (const root of roots) emit(root, 0);
	return rows;
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
		out.push(paint.fg("dim", cut("↑/↓ select · ⏎ view · x stop · ctrl+x ctrl+k stop all · esc back", width)));
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
		const elbow = row.depth > 0 ? `${"  ".repeat(row.depth - 1)}└ ` : "";
		const left = `${elbow}${mark} ${row.label}${row.activity ? `  ${row.activity}` : ""}`;
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

/**
 * Word-aware wrap for prose (task text, assistant text): breaks at spaces,
 * hard-breaking only words longer than the width; preserves blank lines. Plain
 * text in, plain lines out — painting happens after, per line.
 */
export function wrapProse(text: string, width: number): string[] {
	const columns = Math.max(1, width);
	const out: string[] = [];
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		if (raw.trim() === "") {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of raw.split(" ")) {
			const chars = [...word];
			if (chars.length > columns) {
				// A word wider than the screen (path, hash): flush, then hard-break it.
				if (line) out.push(line);
				let i = 0;
				for (; i + columns < chars.length; i += columns) out.push(chars.slice(i, i + columns).join(""));
				line = chars.slice(i).join("");
				continue;
			}
			const candidate = line ? `${line} ${word}` : word;
			if ([...candidate].length > columns) {
				out.push(line);
				line = word;
			} else {
				line = candidate;
			}
		}
		out.push(line);
	}
	return out;
}

/**
 * Renders one prose unit (assistant text) to painted lines at width. `ref`
 * identifies the unit across frames so implementations can cache: a settled
 * block passes the block object, the streaming tail passes a per-run string
 * key. The default is plain `wrapProse`; index.ts injects a pi-tui Markdown
 * renderer (prose.ts) so the child's text matches the main transcript.
 */
export type ProseRenderer = (ref: object | string, text: string, width: number) => string[];

const plainProse: ProseRenderer = (_ref, text, width) => wrapProse(text, width);

export interface TranscriptInput {
	run: LiveRun;
	width: number;
	height: number;
	/** Lines scrolled BACK from the tail; 0 follows the stream (Claude Code style). */
	scroll: number;
	now: number;
	prose?: ProseRenderer;
}

export interface TranscriptOutput {
	lines: string[];
	/** Largest useful `scroll` for the current width/height — the caller's clamp. */
	maxScroll: number;
}

/**
 * The full child session view: a synthesized identity header, the transcript
 * (wrapped, scrollable, tail-anchored so streamed text flows in like the main
 * session), and a live spinner (or terminal status) as the bottom row — key
 * hints live in the strip, like Claude Code's agent tree. Exactly `height`
 * painted lines, blank-filled between body and status — as an overlay every
 * row must paint, or the main transcript bleeds through the gap.
 */
export function renderTranscript(input: TranscriptInput, paint: Paint): TranscriptOutput {
	const { run } = input;
	const width = Math.max(20, input.width);
	const prose = input.prose ?? plainProse;
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

	// Body: settled blocks then the in-flight assistant text, all wrapped, then
	// windowed ANCHORED TO THE TAIL — scroll counts lines back from the end, so
	// the default view follows streaming like Claude Code.
	const bodyRows = Math.max(0, input.height - out.length - 1);
	const blockLines = run.blocks.flatMap((block) => blockToLines(block, width, paint, prose));
	const partial = streamingText(run.streaming).trimEnd();
	if (partial) for (const line of prose(`stream:${run.taskId}`, partial, width)) blockLines.push(line);
	while (blockLines.length && blockLines.at(-1) === "") blockLines.pop();
	const maxScroll = Math.max(0, blockLines.length - bodyRows);
	const start = maxScroll - Math.max(0, Math.min(input.scroll, maxScroll));
	const window = blockLines.slice(start, start + bodyRows);
	for (const line of window) out.push(line);
	while (out.length < input.height - 1) out.push(""); // fill so the status sits at the bottom edge

	// Bottom row: spinner while running, a terminal line otherwise.
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
	// The header alone exceeds a very small height; trim so the "exactly
	// `height` painted lines" contract holds for every caller, not just the
	// one that clamps height to ≥ 8.
	return { lines: out.slice(0, Math.max(1, input.height)), maxScroll };
}

/**
 * A block's painted lines: assistant text goes through the prose renderer,
 * the task prompt stays plain-dim (it is input, not markdown output); both get
 * a trailing blank for paragraph spacing. Call/result stay one line each, a
 * blank after the result so tool groups read like the main transcript.
 */
function blockToLines(block: TranscriptBlock, width: number, paint: Paint, prose: ProseRenderer): string[] {
	if (block.kind === "task") return [...wrapProse(block.text, width).map((l) => paint.fg("dim", l)), ""];
	if (block.kind === "text") return [...prose(block, block.text, width), ""];
	if (block.kind === "call") return [`${paint.fg("accent", "●")} ${cut(`${block.tool}(${block.text})`, width - 2)}`];
	const body = cut(block.text, width - 4);
	return [`  ${paint.fg("dim", "⎿")} ${block.isError ? paint.fg("error", body) : body}`, ""];
}

/** A small inverse-video chip for the label, degrading to `[label]` when narrow. */
function chip(label: string): string {
	return label ? ` ${label} ` : "";
}

/** Header row: splitRow's layout, painted — left name (dropping the chip when fused/narrow). */
function splitPaint(
	paint: Paint,
	leftColor: string,
	left: string,
	right: string,
	width: number,
	boldLeft?: (t: string) => string,
): string {
	const paintLeft = (t: string) => paint.fg(leftColor, boldLeft ? boldLeft(t) : t);
	const row = splitRow(left, right, width);
	if ("fused" in row) return paintLeft(cut(left, width));
	return `${paintLeft(row.left)}  ${paint.fg("accent", paint.bold(row.right))}`;
}
