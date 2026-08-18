import { describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "../../extensions/background/registry.ts";
import { TASK_REGISTER_CHANNEL } from "../../extensions/background/registry.ts";
import { trackShellTasks } from "../../extensions/lib/shell-tasks.ts";
import { decodeStripKey } from "../../extensions/subagents/panel-keys.ts";
import {
	anchorShellFocus,
	MAX_SHELL_LIST_ROWS,
	OUTPUT_BOX_ROWS,
	reduceShellKey,
	renderShellSection,
	SHELL_LIST_LINGER_MS,
	type ShellFocus,
	shellRows,
	shellSectionVisible,
} from "../../extensions/subagents/shell-panel.ts";

/** Paint that tags styled text so tests can strip/inspect it. */
const paint = {
	fg: (color: string, text: string) => `\x1b[fg:${color}]${text}\x1b[/]`,
	bold: (text: string) => `\x1b[b]${text}\x1b[/]`,
	inverse: (text: string) => `\x1b[inv]${text}\x1b[/]`,
};
const strip = (line: string) => line.replace(/\x1b\[[^\]]*\]/g, "");

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: "b1",
		kind: "bash",
		description: "tick loop",
		command: 'for i in {1..6}; do echo "tick $i"; sleep 10; done',
		status: "running",
		startedAt: 1000,
		output: () => "tick 1\ntick 2\n",
		stop: () => {},
		finished: new Promise<void>(() => {}),
		...over,
	};
}

const NOW = 100_000;

describe("shellRows", () => {
	it("orders running shells first, newest-first within each group", () => {
		const rows = shellRows(
			[
				task({ id: "old-run", startedAt: 1000 }),
				task({ id: "done", status: "completed", startedAt: 3000, finishedAt: NOW - 1000 }),
				task({ id: "new-run", startedAt: 2000 }),
			],
			NOW,
		);
		expect(rows.map((t) => t.id)).toEqual(["new-run", "old-run", "done"]);
	});

	it("drops finished shells after the linger window, keeps running ones forever", () => {
		const rows = shellRows(
			[
				task({ id: "stale", status: "completed", finishedAt: NOW - SHELL_LIST_LINGER_MS - 1 }),
				task({ id: "fresh", status: "failed", finishedAt: NOW - 1000 }),
				task({ id: "run", startedAt: 1 }),
			],
			NOW,
		);
		expect(rows.map((t) => t.id)).toEqual(["run", "fresh"]);
	});
});

describe("anchorShellFocus", () => {
	it("keeps a valid selection, re-anchors a vanished one, falls back to chip when empty", () => {
		expect(anchorShellFocus({ stage: "list", selectedId: "a" }, ["a", "b"])).toEqual({ stage: "list", selectedId: "a" });
		expect(anchorShellFocus({ stage: "details", selectedId: "gone" }, ["a"])).toEqual({ stage: "details", selectedId: "a" });
		expect(anchorShellFocus({ stage: "list", selectedId: "gone" }, [])).toEqual({ stage: "chip" });
		expect(anchorShellFocus({ stage: "chip" }, [])).toEqual({ stage: "chip" });
	});
});

describe("reduceShellKey", () => {
	const ids = ["a", "b", "c"];
	const list = (id: string): ShellFocus => ({ stage: "list", selectedId: id });
	const details = (id: string): ShellFocus => ({ stage: "details", selectedId: id });

	it("chip: Enter opens the list on the first row, ↓ hands over to the agent rows", () => {
		expect(reduceShellKey({ stage: "chip" }, "open", ids)).toEqual({ focus: list("a") });
		expect(reduceShellKey({ stage: "chip" }, "down", ids)).toEqual({ focus: undefined, effect: "toAgents" });
		expect(reduceShellKey({ stage: "chip" }, "leave", ids)).toEqual({ focus: undefined });
		expect(reduceShellKey({ stage: "chip" }, "up", ids)).toEqual({ focus: undefined });
	});

	it("chip: Enter with no rows stays on the chip; typing exits with passthrough", () => {
		expect(reduceShellKey({ stage: "chip" }, "open", [])).toEqual({ focus: { stage: "chip" } });
		expect(reduceShellKey({ stage: "chip" }, undefined, ids)).toEqual({ focus: undefined, effect: "passthrough" });
		expect(reduceShellKey({ stage: "chip" }, "stop", ids)).toEqual({ focus: undefined, effect: "passthrough" });
	});

	it("list: arrows select with clamping, Enter opens details, Esc backs to chip", () => {
		expect(reduceShellKey(list("b"), "up", ids)).toEqual({ focus: list("a") });
		expect(reduceShellKey(list("a"), "up", ids)).toEqual({ focus: list("a") });
		expect(reduceShellKey(list("b"), "down", ids)).toEqual({ focus: list("c") });
		expect(reduceShellKey(list("c"), "down", ids)).toEqual({ focus: list("c") });
		expect(reduceShellKey(list("b"), "open", ids)).toEqual({ focus: details("b") });
		expect(reduceShellKey(list("b"), "leave", ids)).toEqual({ focus: { stage: "chip" } });
		expect(reduceShellKey(list("b"), "stop", ids)).toEqual({ focus: list("b"), effect: "stopSelected" });
		expect(reduceShellKey(list("b"), undefined, ids)).toEqual({ focus: undefined, effect: "passthrough" });
	});

	it("details: ← goes back to the list, Esc/Enter/Space close, x stops in place", () => {
		expect(reduceShellKey(details("b"), "left", ids)).toEqual({ focus: list("b") });
		expect(reduceShellKey(details("b"), "leave", ids)).toEqual({ focus: undefined });
		expect(reduceShellKey(details("b"), "open", ids)).toEqual({ focus: undefined });
		expect(reduceShellKey(details("b"), "space", ids)).toEqual({ focus: undefined });
		expect(reduceShellKey(details("b"), "stop", ids)).toEqual({ focus: details("b"), effect: "stopSelected" });
		expect(reduceShellKey(details("b"), "up", ids)).toEqual({ focus: details("b") });
	});
});

describe("decodeStripKey shell additions", () => {
	it("decodes left arrows and space", () => {
		expect(decodeStripKey("\x1b[D", false).key).toBe("left");
		expect(decodeStripKey("\x1bOD", false).key).toBe("left");
		expect(decodeStripKey(" ", false).key).toBe("space");
	});
});

describe("shellSectionVisible", () => {
	it("shows while any row exists (running or lingering) or a focus is held", () => {
		expect(shellSectionVisible(2, undefined)).toBe(true);
		expect(shellSectionVisible(0, { stage: "chip" })).toBe(true);
		expect(shellSectionVisible(0, undefined)).toBe(false);
	});
});

describe("renderShellSection", () => {
	const base = { rows: [task()], runningCount: 1, width: 80, now: NOW };

	it("chip unfocused: a dim one-liner with the manage hint", () => {
		const lines = renderShellSection({ ...base, runningCount: 2, focus: undefined }, paint);
		expect(lines).toHaveLength(1);
		expect(strip(lines[0])).toBe("2 shells · ↓ to manage");
	});

	it("chip focused: inverse-video count plus the Enter hint, singular form", () => {
		const lines = renderShellSection({ ...base, focus: { stage: "chip" } }, paint);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("\x1b[inv] 1 shell \x1b[/]");
		expect(strip(lines[0])).toBe(" 1 shell  · Enter to view tasks"); // the chip keeps its padding
	});

	it("list: header, active count, ❯-marked selection with status, key hints", () => {
		const rows = [task({ id: "a" }), task({ id: "b", status: "completed", finishedAt: NOW - 1, command: "make build" })];
		const lines = renderShellSection({ ...base, rows, runningCount: 1, focus: { stage: "list", selectedId: "b" } }, paint).map(strip);
		expect(lines[0]).toBe("Background");
		expect(lines[1]).toBe("1 active shell");
		expect(lines[3]).toBe('  for i in {1..6}; do echo "tick $i"; sleep 10; done (running)');
		expect(lines[4]).toBe("❯ make build (completed)");
		expect(lines.at(-1)).toBe("↑/↓ to select · Enter to view · x to stop · Esc to close");
	});

	it("details: status fields, a bordered output box showing the tail, hints", () => {
		const many = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
		const lines = renderShellSection(
			{ ...base, rows: [task({ output: () => many })], focus: { stage: "details", selectedId: "b1" }, width: 40 },
			paint,
		).map(strip);
		expect(lines[0]).toBe("Shell details");
		expect(lines[2]).toBe("Status:   running");
		expect(lines[3]).toMatch(/^Runtime: /);
		expect(lines[4]).toMatch(/^Command: {2}for i in/);
		expect(lines[6]).toBe("Output:");
		expect(lines[7]).toBe(`┌${"─".repeat(38)}┐`);
		// Tail-anchored: the box holds the LAST OUTPUT_BOX_ROWS lines.
		expect(lines[8]).toBe(`│ ${"line 6".padEnd(36)} │`);
		expect(lines[7 + OUTPUT_BOX_ROWS]).toBe(`│ ${"line 15".padEnd(36)} │`);
		expect(lines[8 + OUTPUT_BOX_ROWS]).toBe(`└${"─".repeat(38)}┘`);
		expect(lines[9 + OUTPUT_BOX_ROWS]).toBe(`Showing ${OUTPUT_BOX_ROWS} lines`);
		expect(lines.at(-1)).toMatch(/^← to go back · Esc\/Enter\/Space to close/); // cut at width 40
	});

	it("list: windows past MAX_SHELL_LIST_ROWS, sliding to keep the selection visible", () => {
		const rows = Array.from({ length: 12 }, (_, i) => task({ id: `s${i}`, command: `cmd ${i}` }));
		const top = renderShellSection({ ...base, rows, focus: { stage: "list", selectedId: "s0" } }, paint).map(strip);
		expect(top.filter((l) => l.startsWith("❯") || l.startsWith("  cmd"))).toHaveLength(MAX_SHELL_LIST_ROWS);
		expect(top).toContain("  +4 more below");
		expect(top.some((l) => l.includes("more above"))).toBe(false);

		const bottom = renderShellSection({ ...base, rows, focus: { stage: "list", selectedId: "s11" } }, paint).map(strip);
		expect(bottom).toContain("  +4 more above");
		expect(bottom.some((l) => l.startsWith("❯ cmd 11"))).toBe(true);
		expect(bottom.some((l) => l.includes("more below"))).toBe(false);
	});

	it("details: a huge spool still shows the last lines (tail-bounded split)", () => {
		const big = `${"x".repeat(50_000)}\nlast line 1\nlast line 2\n`;
		const lines = renderShellSection(
			{ ...base, rows: [task({ output: () => big })], focus: { stage: "details", selectedId: "b1" }, width: 40 },
			paint,
		).map(strip);
		expect(lines.some((l) => l.includes("last line 2"))).toBe(true);
	});

	it("details: an empty running shell shows a blank box and 0 lines", () => {
		const lines = renderShellSection(
			{ ...base, rows: [task({ output: () => "" })], focus: { stage: "details", selectedId: "b1" }, width: 40 },
			paint,
		).map(strip);
		expect(lines[9 + OUTPUT_BOX_ROWS]).toBe("Showing 0 lines");
	});

	it("details: a vanished shell degrades to a placeholder", () => {
		const lines = renderShellSection({ ...base, rows: [], focus: { stage: "details", selectedId: "gone" } }, paint).map(strip);
		expect(lines.at(-1)).toBe("shell gone");
	});
});

describe("trackShellTasks", () => {
	function fakeBus() {
		const handlers = new Map<string, Array<(payload: unknown) => void>>();
		return {
			events: {
				on(channel: string, handler: (payload: unknown) => void) {
					handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
				},
			},
			emit(channel: string, payload: unknown) {
				for (const handler of handlers.get(channel) ?? []) handler(payload);
			},
		};
	}

	it("mirrors bash tasks only and notifies on register and finish", async () => {
		const bus = fakeBus();
		const tracker = trackShellTasks(bus);
		const seen = vi.fn();
		tracker.subscribe(seen);

		let finish!: () => void;
		const shell = task({ finished: new Promise<void>((r) => (finish = r)) });
		bus.emit(TASK_REGISTER_CHANNEL, shell);
		bus.emit(TASK_REGISTER_CHANNEL, task({ id: "m1", kind: "monitor" }));
		expect(tracker.list().map((t) => t.id)).toEqual(["b1"]);
		expect(tracker.running()).toHaveLength(1);
		expect(seen).toHaveBeenCalledTimes(1);

		shell.status = "completed";
		finish();
		await Promise.resolve();
		expect(tracker.running()).toHaveLength(0);
		expect(seen).toHaveBeenCalledTimes(2);
	});
});
