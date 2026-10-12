/**
 * Pure state + rendering for the background-shells chip in the below-editor
 * panel, Claude Code's shell pill. The FIRST down-arrow focuses it (a second ↓
 * moves on to the agent rows), and Enter opens the Background dialog that
 * `/tasks` opens too (tasks-dialog.ts), where shells and agents are listed
 * together:
 *
 *   "2 shells · ↓ to manage" → focused: "[2 shells] · Enter to view tasks"
 *
 * Task objects arrive over TASK_REGISTER_CHANNEL (lib/shell-tasks.ts) and stay
 * live; status is read at render time. Key wiring lives in index.ts; this file
 * owns layout and the focus reducer only.
 */

import type { BackgroundTask } from "../background/registry.ts";
import { countNoun, cutPlainText as cut } from "../lib/tui-render.ts";
import type { StripKey } from "./panel-keys.ts";
import { type Paint, STRIP_LINGER_MS } from "./panel-render.ts";

export interface ShellPaint extends Paint {
	inverse(text: string): string;
}

/**
 * The shells the chip counts: running ones, and finished ones for as long as a
 * finished agent keeps its strip row (STRIP_LINGER_MS).
 */
export function shellRows(tasks: BackgroundTask[], now: number): BackgroundTask[] {
	return tasks.filter((t) => t.status === "running" || (t.finishedAt !== undefined && t.finishedAt > now - STRIP_LINGER_MS));
}

/**
 * What a key does on the focused chip. Every key drops the chip's focus;
 * openTasks opens the Background dialog, toAgents hands ↓ on to the agent rows,
 * passthrough lets the editor have an unhandled byte, and undefined (↑, Esc)
 * only leaves the chip.
 */
export type ShellKeyEffect = "openTasks" | "toAgents" | "passthrough" | undefined;

/** The focused chip's keys. */
export function reduceShellKey(key: StripKey | undefined): ShellKeyEffect {
	if (key === "down") return "toAgents";
	if (key === "open") return "openTasks";
	if (key === "up" || key === "leave") return undefined;
	return "passthrough";
}

/** The chip's one line. Callers render it only while shellRows() is non-empty. */
export function renderShellChip(count: number, focused: boolean, width: number, paint: ShellPaint): string {
	width = Math.max(20, width);
	if (!focused) return paint.fg("dim", cut(`${countNoun(count, "shell")} · ↓ to manage`, width));
	// Cut the plain parts BEFORE painting: cutting painted text breaks escapes.
	const label = cut(` ${countNoun(count, "shell")} `, width);
	const hint = cut("· Enter to view tasks", Math.max(0, width - label.length - 1));
	return `${paint.inverse(label)}${hint ? ` ${paint.fg("dim", hint)}` : ""}`;
}
