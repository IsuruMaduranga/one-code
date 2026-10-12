/**
 * `/tasks`: Claude Code 2.1.283's Background dialog (findings §40), pure
 * layout and key handling. It lists the shells the chip counts (running ones,
 * and finished ones for the chip's linger window, so Enter on the chip always
 * finds them), the running local agents, and the finished agents the user
 * viewed:
 *
 *   Background
 *   2 active shells · 1 active agent
 *     Shells (2)
 *   ❯ ⏺ sleep 25; echo done   running
 *     Local agents (1)
 *     ⏺ Read notes.txt and report after delay   running · Sonnet 5
 *     Completed (1)
 *     ✔ write a 300-word poem about the word in the file   done · Haiku 4.5
 *   ↑/↓ to select · Enter to view · x to stop · Esc to close
 *
 * With nothing to list it reads `No tasks currently running`. Enter on a shell
 * shows its details in the same dialog (renderShellDetail), and ← goes back
 * to the list. The shells chip below the editor opens this dialog too.
 * index.ts owns the dialog and what Enter and x do.
 */

import type { BackgroundTask } from "../background/registry.ts";
import { countNoun, cutPlainText as cut, formatDuration, hintLines, padPlainText } from "../lib/tui-render.ts";
import { sanitizeDisplayText } from "../lib/terminal-text.ts";

/** One selectable row. */
export type TasksItem =
	| { kind: "shell"; id: string; text: string; running: boolean; status: BackgroundTask["status"] }
	| { kind: "agent"; taskId: string; text: string; model?: string; running: boolean };

export interface TasksDialogInput {
	shells: Array<Extract<TasksItem, { kind: "shell" }>>;
	/** Running agents first, then the viewed finished ones (the caller splits them). */
	agents: Array<Extract<TasksItem, { kind: "agent" }>>;
	selected: number;
	width: number;
}

export interface TasksPaint {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** The agents split into running and completed, each in the caller's order. */
function splitAgents(agents: TasksDialogInput["agents"]) {
	return { running: agents.filter((a) => a.running), completed: agents.filter((a) => !a.running) };
}

/** Every row in display order: shells, running agents, completed agents. */
export function tasksItems(input: Pick<TasksDialogInput, "shells" | "agents">): TasksItem[] {
	const agents = splitAgents(input.agents);
	return [...input.shells, ...agents.running, ...agents.completed];
}

/** The dialog's lines, every one cut to `width`. */
export function renderTasksDialog(input: TasksDialogInput, paint: TasksPaint): string[] {
	const width = Math.max(20, input.width);
	const line = (text: string) => cut(text, width);
	const out = [paint.bold(line("  Background"))];
	const items = tasksItems(input);
	const current = items[input.selected];
	// Hints wrap at their separators on a narrow terminal, so none is cut off.
	const hint = ["↑/↓ to select", "Enter to view", ...(current?.running ? ["x to stop"] : []), "Esc to close"].join(" · ");
	const pushHints = () => out.push(...hintLines(hint, width, "  ").map((hintLine) => paint.fg("dim", hintLine)));
	if (items.length === 0) {
		out.push(line("  No tasks currently running"));
		pushHints();
		return out;
	}
	const agents = splitAgents(input.agents);
	const runningShells = input.shells.filter((s) => s.running).length;
	const counts = [runningShells ? countNoun(runningShells, "active shell") : "", agents.running.length ? countNoun(agents.running.length, "active agent") : ""]
		.filter(Boolean)
		.join(" · ");
	if (counts) out.push(paint.fg("dim", line(`  ${counts}`)));
	const groups: Array<[title: string, rows: TasksItem[]]> = [
		["Shells", input.shells],
		["Local agents", agents.running],
		["Completed", agents.completed],
	];
	let index = 0;
	for (const [title, rows] of groups) {
		if (rows.length === 0) continue;
		out.push(paint.fg("dim", line(`    ${title} (${rows.length})`)));
		for (const row of rows) {
			const selected = index === input.selected;
			// A finished shell shows how it ended; only a clean finish reads "done",
			// and only a failure gets the cross (a stop is the user's own choice).
			const ended = row.kind === "shell" && !row.running && row.status !== "completed" ? row.status : undefined;
			const mark = row.running ? "⏺" : ended === "failed" ? "✗" : "✔";
			const status = row.running ? "running" : (ended ?? "done");
			const suffix = row.kind === "agent" && row.model ? `${status} · ${row.model}` : status;
			const text = line(`  ${selected ? "❯" : " "} ${mark} ${sanitizeDisplayText(row.text)}   ${suffix}`);
			out.push(selected ? paint.fg("accent", paint.bold(text)) : text);
			index++;
		}
	}
	pushHints();
	return out;
}

export type TasksKey = "up" | "down" | "view" | "stop" | "close";

/** Move the selection within `count` rows, stopping at the ends. */
export function moveTasksSelection(selected: number, key: "up" | "down", count: number): number {
	if (count === 0) return 0;
	return key === "up" ? Math.max(0, selected - 1) : Math.min(count - 1, selected + 1);
}

/** What the dialog shows: the list, or one shell's details. */
export type TasksView = { mode: "list" } | { mode: "shell"; id: string };

/**
 * The view to render now. A shell's details last while the shell is known: one
 * that finishes while shown keeps its details, with its final status and no
 * `x`, and the dialog goes back to the list once the shell is gone.
 */
export function settleTasksView(view: TasksView, shellKnown: boolean): TasksView {
	return view.mode === "shell" && !shellKnown ? { mode: "list" } : view;
}

/** What a key does in a shell's details: ← goes back, Esc/Enter/Space close, x stops a running shell. */
export function shellDetailKey(id: string | undefined, text: string | undefined, running: boolean): "back" | "close" | "stop" | undefined {
	if (id === "left") return "back";
	if (id === "escape" || id === "enter" || id === "space" || text === " ") return "close";
	if (running && text?.toLowerCase() === "x") return "stop";
	return undefined;
}

/** Output-box height in a shell's details (content rows, borders excluded). */
export const OUTPUT_BOX_ROWS = 10;

/** Only this much of the spool is split per frame: the box shows 10 lines. */
const OUTPUT_TAIL_CHARS = 8192;

const STATUS_COLOR: Record<string, string> = { running: "accent", failed: "error", stopped: "dim" };

/** One shell's details: Status, Runtime, Command, a bordered tail of its output, and the keys it takes. */
export function renderShellDetail(task: BackgroundTask, width: number, now: number, paint: TasksPaint): string[] {
	width = Math.max(20, width);
	const out = [paint.bold(cut("Shell details", width)), ""];
	const field = (label: string, value: string) => `${paint.bold(padPlainText(label, 9))} ${value}`;
	out.push(field("Status:", paint.fg(STATUS_COLOR[task.status] ?? "dim", task.status)));
	out.push(field("Runtime:", formatDuration(task.startedAt, task.finishedAt, now)));
	out.push(field("Command:", cut(sanitizeDisplayText(task.command ?? task.description), Math.max(1, width - 10))));
	out.push("", paint.bold("Output:"));

	let output = "";
	try {
		output = task.output();
	} catch {
		output = "(output unavailable)";
	}
	// Bound the split to a tail slice: re-splitting a 200KB spool every frame to
	// keep 10 lines is O(buffer) work for nothing. A mid-line cut only matters
	// when the tail holds fewer lines than the box, and those are width-cut anyway.
	const tail = output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
	const lines = tail ? tail.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
	const shown = lines.slice(-OUTPUT_BOX_ROWS);
	const inner = Math.max(1, width - 4);
	out.push(`┌${"─".repeat(Math.max(0, width - 2))}┐`);
	for (let i = 0; i < OUTPUT_BOX_ROWS; i++) out.push(`│ ${padPlainText(cut(shown[i] ?? "", inner), inner)} │`);
	out.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
	out.push(paint.fg("dim", `Showing ${countNoun(shown.length, "line")}`), "");
	const hint = ["← to go back", "Esc/Enter/Space to close", ...(task.status === "running" ? ["x to stop"] : [])].join(" · ");
	out.push(...hintLines(hint, width).map((hintLine) => paint.fg("dim", hintLine)));
	return out;
}
