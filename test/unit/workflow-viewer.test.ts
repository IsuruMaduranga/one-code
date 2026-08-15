import { describe, expect, it } from "vitest";
import {
	buildDetail,
	buildTree,
	clampViewerState,
	decodeStatusKey,
	decodeViewerKey,
	initialViewerState,
	MAX_STATUS_ROWS,
	planSave,
	renderStatusRows,
	renderViewer,
	type ViewerRunSnapshot,
} from "../../extensions/workflow/viewer.ts";
import { wrapPlainText } from "../../extensions/lib/tui-render.ts";
import type { AgentRecord } from "../../extensions/workflow/types.ts";

/** Paint that tags styled text so tests can strip/inspect it. */
const paint = {
	fg: (color: string, text: string) => `\x1b[${color.length}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function agent(overrides: Partial<AgentRecord> & { callIndex: number }): AgentRecord {
	return {
		label: `agent ${overrides.callIndex + 1}`,
		status: "done",
		activity: [],
		startedAt: 1000,
		finishedAt: 3000,
		tokens: { input: 100, output: 29700, total: 29800 },
		...overrides,
	};
}

function run(agents: AgentRecord[], overrides: Partial<ViewerRunSnapshot> = {}): ViewerRunSnapshot {
	return {
		runId: "wf_abc123",
		name: "demo-workflow",
		description: "Tiny demo workflow to show the UI",
		status: "completed",
		startedAt: 0,
		finishedAt: 20_000,
		agents,
		...overrides,
	};
}

describe("decodeViewerKey", () => {
	it("decodes navigation, save, and close keys", () => {
		expect(decodeViewerKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodeViewerKey("\x1bOB")).toEqual({ kind: "down" });
		expect(decodeViewerKey("\x1b[5~")).toEqual({ kind: "pageUp" });
		expect(decodeViewerKey("\t")).toEqual({ kind: "nextRun" });
		expect(decodeViewerKey("s")).toEqual({ kind: "save" });
		expect(decodeViewerKey("\x1b")).toEqual({ kind: "close" });
		expect(decodeViewerKey("\x03")).toEqual({ kind: "close" });
		expect(decodeViewerKey("x")).toBeUndefined();
	});
});

describe("decodeStatusKey", () => {
	it("decodes strip navigation, open, leave, and stop", () => {
		expect(decodeStatusKey("\x1b[A")).toBe("up");
		expect(decodeStatusKey("\x1bOB")).toBe("down");
		expect(decodeStatusKey("\r")).toBe("open");
		expect(decodeStatusKey("\n")).toBe("open");
		expect(decodeStatusKey("\x1b")).toBe("leave");
		expect(decodeStatusKey("x")).toBe("stop");
		expect(decodeStatusKey("X")).toBe("stop");
	});

	it("returns undefined for anything else so typing falls through", () => {
		expect(decodeStatusKey("a")).toBeUndefined();
		expect(decodeStatusKey("\t")).toBeUndefined();
		expect(decodeStatusKey("\x03")).toBeUndefined();
	});
});

describe("initialViewerState", () => {
	it("starts on the requested run", () => {
		expect(initialViewerState().runIndex).toBe(0);
		expect(initialViewerState(2).runIndex).toBe(2);
	});
});

describe("renderStatusRows", () => {
	it("renders one row per run with name, description, and right-aligned stats", () => {
		const rows = renderStatusRows(
			{ runs: [run([agent({ callIndex: 0 }), agent({ callIndex: 1, status: "running" })])], width: 100, now: 11_000 },
			paint,
		);
		expect(rows).toHaveLength(1);
		const text = strip(rows[0]);
		expect(text).toContain("demo-workflow");
		expect(text).toContain("Tiny demo workflow to show the UI");
		expect(text).toContain("1/2 agents done");
		expect(text).toContain("20s"); // finishedAt - startedAt
		expect(text).toContain("↓ 59.4k tokens"); // both agents' output summed
	});

	it("marks the selected row with ❯ and paints it accent", () => {
		const runs = [run([agent({ callIndex: 0 })]), run([agent({ callIndex: 0 })], { runId: "wf_def456", name: "second" })];
		const rows = renderStatusRows({ runs, selected: 1, width: 100, now: 0 }, paint);
		expect(strip(rows[0])).toMatch(/^●/);
		expect(strip(rows[1])).toMatch(/^❯ second/);
		expect(rows[1]).toContain(`\x1b[${"accent".length}m`);
	});

	it("shows run markers by status and appends non-terminal statuses to stats", () => {
		const rows = renderStatusRows(
			{
				runs: [
					run([agent({ callIndex: 0 })], { status: "running", finishedAt: undefined }),
					run([agent({ callIndex: 0, status: "failed" })], { status: "failed" }),
					run([agent({ callIndex: 0 })], { status: "aborted" }),
				],
				width: 100,
				now: 5_000,
			},
			paint,
		);
		expect(strip(rows[0])).toMatch(/^○/);
		expect(strip(rows[1])).toMatch(/^✗/);
		expect(strip(rows[1])).toContain("failed");
		expect(strip(rows[2])).toMatch(/^◼/);
		expect(strip(rows[2])).toContain("aborted");
	});

	it("caps rows and collapses the rest into a +N more line", () => {
		const runs = Array.from({ length: MAX_STATUS_ROWS + 2 }, (_, i) =>
			run([agent({ callIndex: 0 })], { runId: `wf_run${i}`, name: `run-${i}` }),
		);
		const rows = renderStatusRows({ runs, width: 100, now: 0 }, paint);
		expect(rows).toHaveLength(MAX_STATUS_ROWS + 1);
		expect(strip(rows[MAX_STATUS_ROWS])).toContain("+2 more — /workflows");
	});

	it("returns no rows without runs and degrades to one cut line when narrow", () => {
		expect(renderStatusRows({ runs: [], width: 100, now: 0 }, paint)).toEqual([]);
		const rows = renderStatusRows({ runs: [run([agent({ callIndex: 0 })])], width: 24, now: 0 }, paint);
		expect(rows).toHaveLength(1);
		expect([...strip(rows[0])].length).toBeLessThanOrEqual(24);
	});
});

describe("buildTree", () => {
	it("groups agents under phases in first-appearance order with counts", () => {
		const rows = buildTree([
			agent({ callIndex: 0, label: "greeter-1", phase: "Greet" }),
			agent({ callIndex: 1, label: "greeter-2", phase: "Greet" }),
			agent({ callIndex: 2, label: "merger", phase: "Combine" }),
		]);
		expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
			"phase:Greet · 2 agents",
			"agent:greeter-1",
			"agent:greeter-2",
			"phase:Combine · 1 agent",
			"agent:merger",
		]);
	});

	it("puts phaseless agents under a default group", () => {
		const rows = buildTree([agent({ callIndex: 0, label: "solo" })]);
		expect(rows[0].text).toBe("agents · 1 agent");
	});
});

describe("planSave", () => {
	it("writes when the file is absent or identical", () => {
		expect(planSave({ name: "w", exists: false, sameContent: false, confirmed: false }).action).toBe("write");
		expect(planSave({ name: "w", exists: true, sameContent: true, confirmed: false }).action).toBe("write");
	});

	it("requires a second press to overwrite a different file", () => {
		const first = planSave({ name: "w", exists: true, sameContent: false, confirmed: false });
		expect(first.action).toBe("confirm");
		expect(first.notice).toContain("press s again");
		expect(planSave({ name: "w", exists: true, sameContent: false, confirmed: true }).action).toBe("write");
	});
});

describe("buildDetail", () => {
	it("shows status, model, stats, prompt, activity, and outcome", () => {
		const lines = buildDetail(
			agent({
				callIndex: 0,
				label: "greeter-1",
				model: "claude-sonnet-5",
				prompt: "Say hello.",
				activity: [{ name: "bash", argsSummary: "ls" }],
				outcome: "Hello!",
				cost: 0.0123,
			}),
			60,
			5000,
		).map((l) => l.text);
		expect(lines[0]).toBe("✔ Completed · claude-sonnet-5");
		expect(lines[1]).toBe("29.7k out-tok · 2s · $0.0123");
		expect(lines).toContain("Prompt");
		expect(lines).toContain("  Say hello.");
		expect(lines).toContain("  bash(ls)");
		expect(lines).toContain("  Hello!");
	});

	it("marks replayed agents' missing activity and failed agents' error", () => {
		const replayed = buildDetail(agent({ callIndex: 0, status: "replayed" }), 60, 0).map((l) => l.text);
		expect(replayed).toContain("  (replayed — activity not recorded)");
		const failed = buildDetail(
			agent({ callIndex: 0, status: "failed", error: "failed: boom" }),
			60,
			0,
		).map((l) => l.text);
		expect(failed).toContain("Error");
		expect(failed).toContain("  failed: boom");
	});

	it("handles no selection", () => {
		expect(buildDetail(undefined, 60, 0)[0].text).toContain("No agents yet");
	});
});

describe("renderViewer", () => {
	const longPrompt = "A very long prompt ".repeat(30);
	const agents = [
		agent({ callIndex: 0, label: "greeter-with-a-really-long-label-name-1", phase: "Greet", prompt: longPrompt }),
		agent({ callIndex: 1, label: "greeter-2", phase: "Greet", status: "running", finishedAt: undefined }),
		agent({ callIndex: 2, label: "merger", phase: "Combine", status: "failed", error: "failed: nope" }),
	];

	it.each([[30], [69], [70], [80], [120]])("never exceeds width %d (the pi-tui crash invariant)", (width) => {
		const state = initialViewerState();
		const lines = renderViewer({ runs: [run(agents)], state, width, height: 20, now: 5000 }, paint);
		for (const line of lines) {
			expect([...strip(line)].length, `line: ${JSON.stringify(strip(line))}`).toBeLessThanOrEqual(width);
		}
	});

	it("shows header stats and footer hints", () => {
		const state = initialViewerState();
		const lines = renderViewer({ runs: [run(agents)], state, width: 100, height: 20, now: 5000 }, paint).map(strip);
		expect(lines[0]).toContain("demo-workflow");
		expect(lines[0]).toContain("2/3 agents · 20s · completed");
		expect(lines.at(-1)).toContain("↑↓ agent");
		expect(lines.at(-1)).toContain("s save");
	});

	it("marks the cursor row and moves detail with it", () => {
		const state = initialViewerState();
		state.cursor = 2;
		const lines = renderViewer({ runs: [run(agents)], state, width: 100, height: 20, now: 5000 }, paint).map(strip);
		expect(lines.some((l) => l.includes("❯ ✗ merger"))).toBe(true);
		expect(lines.some((l) => l.includes("✗ Failed"))).toBe(true);
	});

	it("stacks panes on narrow terminals", () => {
		const state = initialViewerState();
		const lines = renderViewer({ runs: [run(agents)], state, width: 50, height: 24, now: 5000 }, paint).map(strip);
		expect(lines.some((l) => l.includes("│"))).toBe(false);
		expect(lines.some((l) => l.startsWith("─"))).toBe(true);
	});

	it("renders the empty state without runs", () => {
		const lines = renderViewer({ runs: [], state: initialViewerState(), width: 80, height: 10, now: 0 }, paint).map(
			strip,
		);
		expect(lines.join("\n")).toContain("No workflow runs this session.");
	});

	it("shows a transient notice instead of hints, and the run-cycle hint with multiple runs", () => {
		const state = initialViewerState();
		state.notice = "saved to .claude/workflows/demo-workflow.js";
		const runs = [run(agents), run([], { runId: "wf_def456", name: "other" })];
		const lines = renderViewer({ runs, state, width: 100, height: 20, now: 5000 }, paint).map(strip);
		expect(lines.at(-1)).toContain("saved to");
		expect(lines[1]).toContain("run 1/2 (tab)");
	});

	it("clamps cursor when agents shrink between renders", () => {
		const state = initialViewerState();
		state.cursor = 99;
		clampViewerState(state, [run(agents)]);
		expect(state.cursor).toBe(2);
	});
});

describe("helpers", () => {
	it("wrapPlainText wraps and preserves blank lines", () => {
		expect(wrapPlainText("abcdef\n\nxy", 3)).toEqual(["abc", "def", "", "xy"]);
	});
});
