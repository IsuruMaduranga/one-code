import { describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "../../extensions/background/registry.ts";
import { TASK_REGISTER_CHANNEL } from "../../extensions/background/registry.ts";
import { trackShellTasks } from "../../extensions/lib/shell-tasks.ts";
import { decodeStripKey } from "../../extensions/subagents/panel-keys.ts";
import { STRIP_LINGER_MS } from "../../extensions/subagents/panel-render.ts";
import { reduceShellKey, renderShellChip, shellRows } from "../../extensions/subagents/shell-panel.ts";
import { OUTPUT_BOX_ROWS, renderShellDetail, settleTasksView, shellDetailKey } from "../../extensions/subagents/tasks-dialog.ts";

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
	it("keeps running shells, and a finished one only for the agent rows' linger window", () => {
		const rows = shellRows(
			[
				task({ id: "run", startedAt: 1 }),
				task({ id: "stale", status: "completed", finishedAt: NOW - STRIP_LINGER_MS - 1 }),
				task({ id: "fresh", status: "stopped", finishedAt: NOW - 1000 }),
			],
			NOW,
		);
		expect(rows.map((t) => t.id)).toEqual(["run", "fresh"]);
		// A shell that finished a minute ago no longer holds the chip.
		expect(shellRows([task({ status: "completed", finishedAt: NOW - 60_000 })], NOW)).toEqual([]);
	});
});

describe("reduceShellKey", () => {
	it("Enter opens the Background dialog, ↓ hands over to the agent rows, ↑/Esc leave", () => {
		expect(reduceShellKey("open")).toBe("openTasks");
		expect(reduceShellKey("down")).toBe("toAgents");
		expect(reduceShellKey("leave")).toBeUndefined();
		expect(reduceShellKey("up")).toBeUndefined();
	});

	it("typing and keys the chip does not take pass through to the editor", () => {
		expect(reduceShellKey(undefined)).toBe("passthrough");
		expect(reduceShellKey("stop")).toBe("passthrough");
		// ← and space are typing here: the chip lets go and the editor gets the byte.
		expect(reduceShellKey(decodeStripKey("\x1b[D", false).key)).toBe("passthrough");
		expect(reduceShellKey(decodeStripKey(" ", false).key)).toBe("passthrough");
	});
});

describe("renderShellChip", () => {
	it("unfocused: a dim one-liner with the manage hint", () => {
		expect(strip(renderShellChip(2, false, 80, paint))).toBe("2 shells · ↓ to manage");
	});

	it("focused: inverse-video count plus the Enter hint, singular form", () => {
		const line = renderShellChip(1, true, 80, paint);
		expect(line).toContain("\x1b[inv] 1 shell \x1b[/]");
		expect(strip(line)).toBe(" 1 shell  · Enter to view tasks"); // the chip keeps its padding
	});
});

describe("shell details in the Background dialog", () => {
	it("shows status fields, a bordered output box with the tail, and x on a running shell", () => {
		const many = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
		const lines = renderShellDetail(task({ output: () => many }), 40, NOW, paint).map(strip);
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
		expect(strip(renderShellDetail(task(), 100, NOW, paint).at(-1)!)).toBe("← to go back · Esc/Enter/Space to close · x to stop");
		// On a narrow terminal the hints wrap, so x to stop stays on screen.
		const narrow = renderShellDetail(task(), 30, NOW, paint).map(strip);
		expect(narrow.slice(-3).join(" · ")).toContain("x to stop");
		for (const line of narrow.slice(-3)) expect(line.length).toBeLessThanOrEqual(30);
	});

	it("never offers x on a finished or stopped shell", () => {
		for (const status of ["completed", "stopped", "failed"] as const) {
			const hint = strip(renderShellDetail(task({ status, finishedAt: NOW - 1 }), 100, NOW, paint).at(-1)!);
			expect(hint).toBe("← to go back · Esc/Enter/Space to close");
		}
	});

	it("a huge spool still shows the last lines; an empty one shows 0 lines", () => {
		const big = `${"x".repeat(50_000)}\nlast line 1\nlast line 2\n`;
		expect(renderShellDetail(task({ output: () => big }), 40, NOW, paint).map(strip).some((l) => l.includes("last line 2"))).toBe(true);
		expect(renderShellDetail(task({ output: () => "" }), 40, NOW, paint).map(strip)[9 + OUTPUT_BOX_ROWS]).toBe("Showing 0 lines");
	});

	it("keys: ← goes back, Esc/Enter/Space close, x stops only a running shell", () => {
		expect(shellDetailKey("left", undefined, true)).toBe("back");
		expect(shellDetailKey("escape", undefined, true)).toBe("close");
		expect(shellDetailKey("enter", undefined, true)).toBe("close");
		expect(shellDetailKey(undefined, " ", true)).toBe("close");
		expect(shellDetailKey(undefined, "x", true)).toBe("stop");
		expect(shellDetailKey(undefined, "x", false)).toBeUndefined();
	});

	it("keeps a finished shell's details, and goes back to the list once the shell is gone", () => {
		const view = { mode: "shell" as const, id: "b1" };
		expect(settleTasksView(view, { status: "running" })).toBe(view);
		expect(settleTasksView(view, { status: "stopped" })).toBe(view);
		expect(settleTasksView(view, undefined)).toEqual({ mode: "list" });
		expect(settleTasksView({ mode: "list" }, undefined)).toEqual({ mode: "list" });
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
