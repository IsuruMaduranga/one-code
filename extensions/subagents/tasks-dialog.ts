/**
 * `/tasks`: Claude Code 2.1.283's Background dialog (findings §40), pure
 * layout and key handling. It lists the running shells, the running local
 * agents, and the finished agents the user viewed:
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
 * With nothing to list it reads `No tasks currently running`. index.ts owns the
 * dialog and what Enter and x do.
 */

import { countNoun, cutPlainText as cut } from "../lib/tui-render.ts";
import { sanitizeDisplayText } from "../lib/terminal-text.ts";

/** One selectable row. */
export type TasksItem =
	| { kind: "shell"; id: string; text: string; running: boolean }
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
	if (items.length === 0) {
		out.push(line("  No tasks currently running"));
		out.push(paint.fg("dim", line("  ↑/↓ to select · Enter to view · Esc to close")));
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
			const mark = row.running ? "⏺" : "✔";
			const status = row.running ? "running" : "done";
			const suffix = row.kind === "agent" && row.model ? `${status} · ${row.model}` : status;
			const text = line(`  ${selected ? "❯" : " "} ${mark} ${sanitizeDisplayText(row.text)}   ${suffix}`);
			out.push(selected ? paint.fg("accent", paint.bold(text)) : text);
			index++;
		}
	}
	const current = items[input.selected];
	const hint = ["↑/↓ to select", "Enter to view", ...(current?.running ? ["x to stop"] : []), "Esc to close"].join(" · ");
	out.push(paint.fg("dim", line(`  ${hint}`)));
	return out;
}

export type TasksKey = "up" | "down" | "view" | "stop" | "close";

/** Move the selection within `count` rows, stopping at the ends. */
export function moveTasksSelection(selected: number, key: "up" | "down", count: number): number {
	if (count === 0) return 0;
	return key === "up" ? Math.max(0, selected - 1) : Math.min(count - 1, selected + 1);
}
