import { describe, expect, it } from "vitest";
import {
	buildDetail,
	buildPhases,
	clampViewerState,
	decodeStatusKey,
	decodeViewerKey,
	initialViewerState,
	MAX_STATUS_ROWS,
	planSave,
	PROMPT_PREVIEW_LINES,
	renderStatusRows,
	renderViewer,
	type ViewerRunSnapshot,
} from "../../extensions/workflow/viewer.ts";
import { formatDuration, wrapPlainText } from "../../extensions/lib/tui-render.ts";
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
		toolCalls: 0,
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
	it("decodes navigation, drill, save, stop, and close keys", () => {
		expect(decodeViewerKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodeViewerKey("\x1bOB")).toEqual({ kind: "down" });
		expect(decodeViewerKey("\x1b[5~")).toEqual({ kind: "pageUp" });
		expect(decodeViewerKey("\t")).toEqual({ kind: "nextRun" });
		expect(decodeViewerKey("\r")).toEqual({ kind: "enter" });
		expect(decodeViewerKey("\x1b")).toEqual({ kind: "back" });
		expect(decodeViewerKey("x")).toEqual({ kind: "stop" });
		expect(decodeViewerKey("s")).toEqual({ kind: "save" });
		expect(decodeViewerKey("q")).toEqual({ kind: "close" });
		expect(decodeViewerKey("\x03")).toEqual({ kind: "close" });
		expect(decodeViewerKey("z")).toBeUndefined();
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
	it("starts on the requested run, at the phases level", () => {
		expect(initialViewerState().runIndex).toBe(0);
		expect(initialViewerState(2).runIndex).toBe(2);
		expect(initialViewerState().level).toBe("phases");
	});
});

describe("formatDuration", () => {
	it("formats seconds, minutes, and hours the Claude Code way", () => {
		expect(formatDuration(0, 45_000)).toBe("45s");
		expect(formatDuration(0, 67_000)).toBe("1m 7s");
		expect(formatDuration(0, 3_600_000 + 5 * 60_000)).toBe("1h 5m");
		expect(formatDuration(0, undefined, 12_000)).toBe("12s");
		expect(formatDuration(undefined)).toBe("");
	});
});

describe("buildPhases", () => {
	it("lists declared phases first, then marks started ones with counts", () => {
		const phases = buildPhases(
			run([agent({ callIndex: 0, phase: "Survey" }), agent({ callIndex: 1, phase: "Survey", status: "running" })], {
				declaredPhases: ["Survey", "Analyze", "Synthesize"],
			}),
		);
		expect(phases.map((p) => p.title)).toEqual(["Survey", "Analyze", "Synthesize"]);
		expect(phases[0]).toMatchObject({ started: true, done: 1 });
		expect(phases[0].agents).toHaveLength(2);
		expect(phases[1]).toMatchObject({ started: false, agents: [] });
	});

	it("appends undeclared event phases and defaults phaseless agents to 'agents'", () => {
		const phases = buildPhases(
			run([agent({ callIndex: 0, phase: "▸ child · Scan" }), agent({ callIndex: 1 })], {
				declaredPhases: ["Main"],
			}),
		);
		expect(phases.map((p) => p.title)).toEqual(["Main", "▸ child · Scan", "agents"]);
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

	it("formats long elapsed times as minutes", () => {
		const rows = renderStatusRows(
			{ runs: [run([agent({ callIndex: 0 })], { finishedAt: 67_000 })], width: 100, now: 0 },
			paint,
		);
		expect(strip(rows[0])).toContain("1m 7s");
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
		// Callers may pass only the visible slice with the session total alongside.
		const sliced = renderStatusRows({ runs: runs.slice(0, MAX_STATUS_ROWS), totalRuns: runs.length, width: 100, now: 0 }, paint);
		expect(sliced).toEqual(rows);
	});

	it("returns no rows without runs and degrades to one cut line when narrow", () => {
		expect(renderStatusRows({ runs: [], width: 100, now: 0 }, paint)).toEqual([]);
		const rows = renderStatusRows({ runs: [run([agent({ callIndex: 0 })])], width: 24, now: 0 }, paint);
		expect(rows).toHaveLength(1);
		expect([...strip(rows[0])].length).toBeLessThanOrEqual(24);
	});
});

describe("buildDetail", () => {
	it("shows status, model, stats with tool-call count, prompt, activity, and outcome", () => {
		const lines = buildDetail(
			agent({
				callIndex: 0,
				label: "greeter-1",
				model: "claude-sonnet-5",
				prompt: "Say hello.",
				activity: [{ name: "bash", argsSummary: "ls" }],
				toolCalls: 1,
				outcome: "Hello!",
				cost: 0.0123,
			}),
			60,
			5000,
			false,
		).map((l) => l.text);
		expect(lines[0]).toBe("✔ Completed · claude-sonnet-5");
		expect(lines[1]).toBe("29.7k tok · 1 tool call · 2s · $0.0123");
		expect(lines).toContain("Prompt");
		expect(lines).toContain("  Say hello.");
		expect(lines).toContain("  bash(ls)");
		expect(lines).toContain("  Hello!");
	});

	it("collapses long prompts to a preview until expanded", () => {
		const longPrompt = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
		const collapsed = buildDetail(agent({ callIndex: 0, prompt: longPrompt }), 60, 0, false).map((l) => l.text);
		const promptAt = collapsed.indexOf("Prompt");
		expect(collapsed[promptAt + PROMPT_PREVIEW_LINES + 1]).toContain("more line");
		expect(collapsed[promptAt + PROMPT_PREVIEW_LINES + 1]).toContain("⏎ to expand");
		const expanded = buildDetail(agent({ callIndex: 0, prompt: longPrompt }), 60, 0, true).map((l) => l.text);
		expect(expanded).toContain("  line 7");
	});

	it("shows only the activity tail with a last-N-of-M header", () => {
		const activity = Array.from({ length: 7 }, (_, i) => ({ name: "read", argsSummary: `file${i}` }));
		const lines = buildDetail(agent({ callIndex: 0, activity, toolCalls: 7 }), 60, 0, false).map((l) => l.text);
		expect(lines).toContain("Activity · last 3 of 7 tool calls");
		expect(lines).toContain("  read(file6)");
		expect(lines).not.toContain("  read(file0)");
	});

	it("marks running agents' outcome as still running, replayed activity, and failures", () => {
		const running = buildDetail(agent({ callIndex: 0, status: "running", finishedAt: undefined }), 60, 0, false).map(
			(l) => l.text,
		);
		expect(running).toContain("  Still running…");
		const replayed = buildDetail(agent({ callIndex: 0, status: "replayed" }), 60, 0, false).map((l) => l.text);
		expect(replayed).toContain("  (replayed — activity not recorded)");
		const failed = buildDetail(agent({ callIndex: 0, status: "failed", error: "failed: boom" }), 60, 0, false).map(
			(l) => l.text,
		);
		expect(failed).toContain("Error");
		expect(failed).toContain("  failed: boom");
	});

	it("handles no selection", () => {
		expect(buildDetail(undefined, 60, 0, false)[0].text).toContain("No agents yet");
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
		for (const level of ["phases", "agents"] as const) {
			const state = initialViewerState();
			state.level = level;
			const lines = renderViewer({ runs: [run(agents)], state, width, height: 20, now: 5000 }, paint);
			for (const line of lines) {
				expect([...strip(line)].length, `level ${level} line: ${JSON.stringify(strip(line))}`).toBeLessThanOrEqual(
					width,
				);
			}
		}
	});

	it("shows header stats and the phases-level panes and hints", () => {
		const state = initialViewerState();
		const lines = renderViewer({ runs: [run(agents)], state, width: 100, height: 20, now: 5000 }, paint).map(strip);
		expect(lines[0]).toContain("demo-workflow");
		expect(lines[0]).toContain("2/3 agents · 20s · completed");
		expect(lines.some((l) => l.includes("Phases"))).toBe(true);
		expect(lines.some((l) => l.includes("Greet · 2 agents"))).toBe(true);
		expect(lines.some((l) => l.includes("❯ Greet"))).toBe(true);
		expect(lines.at(-1)).toContain("↑↓ select");
		expect(lines.at(-1)).toContain("⏎ open");
		expect(lines.at(-1)).toContain("esc close");
	});

	it("omits the status word and shows the stop hint while running", () => {
		const state = initialViewerState();
		const lines = renderViewer(
			{ runs: [run(agents, { status: "running", finishedAt: undefined })], state, width: 100, height: 20, now: 5000 },
			paint,
		).map(strip);
		expect(lines[0]).not.toContain("running");
		expect(lines.at(-1)).toContain("x stop workflow");
	});

	it("marks done phases with ✔ and dims declared-but-unstarted phases", () => {
		const state = initialViewerState();
		state.phaseCursor = 1;
		const lines = renderViewer(
			{
				runs: [
					run([agent({ callIndex: 0, phase: "Survey" })], { declaredPhases: ["Survey", "Analyze", "Synthesize"] }),
				],
				state,
				width: 100,
				height: 20,
				now: 5000,
			},
			paint,
		).map(strip);
		expect(lines.some((l) => l.includes("✔ Survey") && l.includes("1/1"))).toBe(true);
		expect(lines.some((l) => l.includes("❯ Analyze"))).toBe(true);
		expect(lines.some((l) => l.includes("3 Synthesize"))).toBe(true);
	});

	it("drills into the agents level: agent list left, detail right", () => {
		const state = initialViewerState();
		state.level = "agents";
		state.agentCursor = 1;
		const lines = renderViewer({ runs: [run(agents)], state, width: 100, height: 20, now: 5000 }, paint).map(strip);
		expect(lines.some((l) => l.includes("Greet · 2 agents"))).toBe(true);
		expect(lines.some((l) => l.includes("❯ ● greeter-2"))).toBe(true);
		expect(lines.some((l) => l.includes("● Running"))).toBe(true);
		expect(lines.at(-1)).toContain("↑↓ agent");
		expect(lines.at(-1)).toContain("⏎ prompt");
		expect(lines.at(-1)).toContain("esc back");
	});

	it("shows the failed agent's detail from the second phase", () => {
		const state = initialViewerState();
		state.phaseCursor = 1;
		state.level = "agents";
		const lines = renderViewer({ runs: [run(agents)], state, width: 100, height: 20, now: 5000 }, paint).map(strip);
		expect(lines.some((l) => l.includes("❯ ✗ merger"))).toBe(true);
		expect(lines.some((l) => l.includes("✗ Failed"))).toBe(true);
	});

	it("stacks panes on narrow terminals without side-by-side joins", () => {
		const state = initialViewerState();
		const lines = renderViewer({ runs: [run(agents)], state, width: 50, height: 24, now: 5000 }, paint).map(strip);
		// Every box border is full width — no line carries two boxes.
		expect(lines.some((l) => l.includes("┐ ┌"))).toBe(false);
		expect(lines.some((l) => l.startsWith("┌ Phases"))).toBe(true);
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

	it("clamps cursors when agents shrink and drops to phases when a phase empties", () => {
		const state = initialViewerState();
		state.phaseCursor = 99;
		state.agentCursor = 99;
		state.level = "agents";
		clampViewerState(state, [run(agents)]);
		expect(state.phaseCursor).toBe(1); // Combine
		expect(state.agentCursor).toBe(0);
		const empty = initialViewerState();
		empty.level = "agents";
		clampViewerState(empty, [run([], { declaredPhases: ["Later"] })]);
		expect(empty.level).toBe("phases");
	});
});

describe("helpers", () => {
	it("wrapPlainText wraps and preserves blank lines", () => {
		expect(wrapPlainText("abcdef\n\nxy", 3)).toEqual(["abc", "def", "", "xy"]);
	});
});
