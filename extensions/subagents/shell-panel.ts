/**
 * Pure state + rendering for the background-shells side of the below-editor
 * panel — Claude Code's shell manager. Three stages, entered with the FIRST
 * down-arrow (a second ↓ moves on to the agent rows):
 *
 *   chip     "2 shells · ↓ to manage" → focused: "[2 shells] · Enter to view tasks"
 *   list     the Background panel: selectable command rows, x stops, Esc backs out
 *   details  one shell: Status/Runtime/Command + a live bordered output box
 *
 * Task objects arrive over TASK_REGISTER_CHANNEL (lib/shell-tasks.ts) and stay
 * live — output()/status are read at render time. Key wiring lives in
 * index.ts; this file owns layout and the focus reducer only.
 */

import type { BackgroundTask } from "../background/registry.ts";
import { countNoun, cutPlainText as cut, formatDuration, padPlainText } from "../lib/tui-render.ts";
import type { StripKey } from "./panel-keys.ts";
import type { Paint } from "./panel-render.ts";

export interface ShellPaint extends Paint {
	inverse(text: string): string;
}

export type ShellFocus =
	| { stage: "chip" }
	| { stage: "list"; selectedId: string }
	| { stage: "details"; selectedId: string };

/** A finished shell stays listed this long, so its terminal status is seen. */
export const SHELL_LIST_LINGER_MS = 60_000;

/** Output-box height in the details view (content rows, borders excluded). */
export const OUTPUT_BOX_ROWS = 10;

/** Most list rows shown at once; the selection slides a window over the rest. */
export const MAX_SHELL_LIST_ROWS = 8;

/** Only this much of the spool is split per frame — the box shows 10 lines. */
const OUTPUT_TAIL_CHARS = 8192;

/** The list rows: running shells first, newest-first within each group. */
export function shellRows(tasks: BackgroundTask[], now: number): BackgroundTask[] {
	return tasks
		.filter((t) => t.status === "running" || (t.finishedAt ?? now) > now - SHELL_LIST_LINGER_MS)
		.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
}

/**
 * Re-anchor a focus whose selected shell left the rows (lingered out or never
 * existed): fall back to the first row, or to the chip when the list emptied.
 */
export function anchorShellFocus(focus: ShellFocus, ids: string[]): ShellFocus {
	if (focus.stage === "chip" || ids.includes(focus.selectedId)) return focus;
	return ids.length ? { ...focus, selectedId: ids[0] } : { stage: "chip" };
}

export interface ShellTransition {
	/** The next focus; undefined closes the shell section entirely. */
	focus: ShellFocus | undefined;
	/** stopSelected: stop the selected task; toAgents: hand ↓ on to the agent
	 * rows; passthrough: unhandled byte — drop focus and let the editor have it. */
	effect?: "stopSelected" | "toAgents" | "passthrough";
}

/**
 * The focus reducer — Claude Code's shell-manager keys. `ids` is the current
 * row order (shellRows), `focus` is already anchored against it.
 */
export function reduceShellKey(focus: ShellFocus, key: StripKey | undefined, ids: string[]): ShellTransition {
	const index = focus.stage === "chip" ? -1 : ids.indexOf(focus.selectedId);
	switch (focus.stage) {
		case "chip":
			if (key === "down") return { focus: undefined, effect: "toAgents" };
			if (key === "open") return { focus: ids.length ? { stage: "list", selectedId: ids[0] } : focus };
			if (key === "up" || key === "leave") return { focus: undefined };
			return { focus: undefined, effect: "passthrough" };
		case "list":
			if (key === "up") return { focus: index > 0 ? { stage: "list", selectedId: ids[index - 1] } : focus };
			if (key === "down")
				return { focus: index < ids.length - 1 ? { stage: "list", selectedId: ids[index + 1] } : focus };
			if (key === "open") return { focus: { stage: "details", selectedId: focus.selectedId } };
			if (key === "stop") return { focus, effect: "stopSelected" };
			if (key === "leave" || key === "left") return { focus: { stage: "chip" } };
			if (key === "pageUp" || key === "pageDown") return { focus };
			return { focus: undefined, effect: "passthrough" };
		case "details":
			if (key === "left") return { focus: { stage: "list", selectedId: focus.selectedId } };
			if (key === "leave" || key === "open" || key === "space") return { focus: undefined };
			if (key === "stop") return { focus, effect: "stopSelected" };
			if (key === "up" || key === "down" || key === "pageUp" || key === "pageDown") return { focus };
			return { focus: undefined, effect: "passthrough" };
	}
}

export interface ShellSectionInput {
	/** shellRows()-ordered. */
	rows: BackgroundTask[];
	runningCount: number;
	focus: ShellFocus | undefined;
	width: number;
	now: number;
}

/**
 * Whether the section renders at all (drives widget visibility and ↓ entry).
 * Keyed on the ROW count, not the running count, so a finished shell's chip
 * stays reachable for the linger window — otherwise its outcome would only be
 * visible if the panel happened to be open when it finished.
 */
export function shellSectionVisible(rowCount: number, focus: ShellFocus | undefined): boolean {
	return rowCount > 0 || focus !== undefined;
}

const STATUS_COLOR: Record<string, string> = { running: "accent", failed: "error", stopped: "dim" };

/** The section's lines at the current stage. Caller checks visibility first. */
export function renderShellSection(input: ShellSectionInput, paint: ShellPaint): string[] {
	const width = Math.max(20, input.width);
	const focus = input.focus;
	if (!focus) return [paint.fg("dim", cut(`${countNoun(input.runningCount, "shell")} · ↓ to manage`, width))];
	if (focus.stage === "chip") {
		// Cut the plain parts BEFORE painting — cutting painted text breaks escapes.
		const label = cut(` ${countNoun(input.runningCount, "shell")} `, width);
		const hint = cut("· Enter to view tasks", Math.max(0, width - label.length - 1));
		return [`${paint.inverse(label)}${hint ? ` ${paint.fg("dim", hint)}` : ""}`];
	}
	if (focus.stage === "list") return renderShellList(input, focus.selectedId, paint, width);
	return renderShellDetails(input, focus.selectedId, paint, width);
}

function renderShellList(input: ShellSectionInput, selectedId: string, paint: ShellPaint, width: number): string[] {
	const out: string[] = [];
	out.push(paint.fg("accent", paint.bold("Background")));
	out.push(cut(countNoun(input.runningCount, "active shell"), width));
	out.push("");
	// A window of MAX_SHELL_LIST_ROWS slid to keep the selection visible, so a
	// big shell fan-out cannot grow the panel past the terminal.
	const selectedIndex = Math.max(0, input.rows.findIndex((t) => t.id === selectedId));
	const start = Math.min(Math.max(0, selectedIndex - MAX_SHELL_LIST_ROWS + 1), Math.max(0, input.rows.length - MAX_SHELL_LIST_ROWS));
	const shown = input.rows.slice(start, start + MAX_SHELL_LIST_ROWS);
	if (start > 0) out.push(paint.fg("dim", `  +${start} more above`));
	for (const task of shown) {
		const marker = task.id === selectedId ? "❯ " : "  ";
		const status = ` (${task.status})`;
		const command = cut(task.command ?? task.description, Math.max(1, width - marker.length - status.length));
		out.push(`${marker}${command}${paint.fg(STATUS_COLOR[task.status] ?? "dim", status)}`);
	}
	const below = input.rows.length - start - shown.length;
	if (below > 0) out.push(paint.fg("dim", `  +${below} more below`));
	if (!input.rows.length) out.push(paint.fg("dim", "  no shells"));
	out.push("");
	out.push(paint.fg("dim", cut("↑/↓ to select · Enter to view · x to stop · Esc to close", width)));
	return out;
}

function renderShellDetails(input: ShellSectionInput, selectedId: string, paint: ShellPaint, width: number): string[] {
	const task = input.rows.find((t) => t.id === selectedId);
	const out: string[] = [];
	out.push(paint.fg("accent", paint.bold("Shell details")));
	out.push("");
	if (!task) {
		out.push(paint.fg("dim", "shell gone"));
		return out;
	}
	const field = (label: string, value: string) => `${paint.bold(padPlainText(label, 9))} ${value}`;
	out.push(field("Status:", paint.fg(STATUS_COLOR[task.status] ?? "dim", task.status)));
	out.push(field("Runtime:", formatDuration(task.startedAt, task.finishedAt, input.now)));
	out.push(field("Command:", cut(task.command ?? task.description, Math.max(1, width - 10))));
	out.push("");
	out.push(paint.bold("Output:"));

	let output = "";
	try {
		output = task.output();
	} catch {
		output = "(output unavailable)";
	}
	// Bound the split to a tail slice — re-splitting a 200KB spool every ticker
	// frame to keep 10 lines is O(buffer) work for nothing. A mid-line cut only
	// matters when the tail holds fewer lines than the box, and those are
	// width-cut anyway.
	const tail = output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
	const lines = tail ? tail.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
	const shown = lines.slice(-OUTPUT_BOX_ROWS);
	const inner = Math.max(1, width - 4);
	out.push(`┌${"─".repeat(Math.max(0, width - 2))}┐`);
	for (let i = 0; i < OUTPUT_BOX_ROWS; i++) {
		out.push(`│ ${padPlainText(cut(shown[i] ?? "", inner), inner)} │`);
	}
	out.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
	out.push(paint.fg("dim", `Showing ${countNoun(shown.length, "line")}`));
	out.push("");
	out.push(paint.fg("dim", cut("← to go back · Esc/Enter/Space to close · x to stop", width)));
	return out;
}
