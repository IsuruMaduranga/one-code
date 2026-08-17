import { describe, expect, it } from "vitest";
import {
	deriveActivity,
	deriveLabel,
	LiveRunRegistry,
	MAX_BLOCKS,
	type LiveRun,
} from "../../extensions/subagents/live-runs.ts";
import {
	buildRows,
	MAX_STRIP_ROWS,
	renderStrip,
	renderTranscript,
	spinnerVerb,
} from "../../extensions/subagents/panel-render.ts";
import { decodeStripKey, decodeViewerKey } from "../../extensions/subagents/panel-keys.ts";

/** Paint that tags styled text so tests can strip/inspect it. */
const paint = {
	fg: (color: string, text: string) => `\x1b[fg:${color}]${text}\x1b[/]`,
	bold: (text: string) => `\x1b[b]${text}\x1b[/]`,
};
const strip = (line: string) => line.replace(/\x1b\[[^\]]*\]/g, "");

function register(reg: LiveRunRegistry, over: Partial<{ taskId: string; name: string; agentType: string; task: string; startedAt: number }> = {}): string {
	const taskId = over.taskId ?? "t1";
	reg.register({
		taskId,
		name: over.name ?? "general-purpose-1",
		agentType: over.agentType ?? "general-purpose",
		task: over.task ?? "Efficiency review of diff\nmore detail",
		startedAt: over.startedAt ?? 1000,
	});
	return taskId;
}

describe("deriveLabel", () => {
	it("takes the first non-empty line, truncating long ones", () => {
		expect(deriveLabel("\n  Efficiency review of diff  \nrest", "fallback")).toBe("Efficiency review of diff");
		expect(deriveLabel("", "general-purpose-1")).toBe("general-purpose-1");
		expect(deriveLabel("x".repeat(80), "f")).toHaveLength(58); // 57 + ellipsis
	});
});

describe("deriveActivity", () => {
	it("maps tool calls to present-tense activity", () => {
		expect(deriveActivity("Read", { file_path: "/a/b/tui-render.ts" }, "")).toBe("Reading tui-render.ts");
		expect(deriveActivity("read", { file_path: "/x/store.ts" }, "")).toBe("Reading store.ts");
		expect(deriveActivity("Bash", { command: "ls" }, "")).toBe("Running a command");
		expect(deriveActivity("Grep", { pattern: "todo_write" }, "")).toBe("Searching todo_write");
		expect(deriveActivity("MysteryTool", {}, "")).toBe("Running MysteryTool");
	});
	it("falls back to the first line of assistant text, then a generic verb", () => {
		expect(deriveActivity(undefined, undefined, "  Let me look at the tests\nthen fix")).toBe("Let me look at the tests");
		expect(deriveActivity(undefined, undefined, "")).toBe("Working…");
	});
});

describe("LiveRunRegistry", () => {
	it("registers, updates stats/activity, appends blocks, and finishes", () => {
		const reg = new LiveRunRegistry();
		let changes = 0;
		reg.subscribe(() => changes++);
		const id = register(reg);
		const run = reg.get(id) as LiveRun;
		expect(run.status).toBe("running");
		expect(run.label).toBe("Efficiency review of diff");

		reg.stats(id, 3, { input: 0, output: 500, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
		reg.setActivity(id, "Reading store.ts");
		reg.block(id, { kind: "call", tool: "Read", text: "store.ts" });
		expect(reg.get(id)?.toolCalls).toBe(3);
		expect(reg.get(id)?.tokens.output).toBe(500);
		expect(reg.get(id)?.activity).toBe("Reading store.ts");
		expect(reg.get(id)?.blocks).toHaveLength(1);
		expect(changes).toBeGreaterThan(3);

		reg.finish(id, false);
		expect(reg.get(id)?.status).toBe("done");
		expect(reg.get(id)?.finishedAt).toBeGreaterThan(0);
		expect(reg.anyRunning()).toBe(false);
	});

	it("bounds the block list at MAX_BLOCKS", () => {
		const reg = new LiveRunRegistry();
		const id = register(reg);
		for (let i = 0; i < MAX_BLOCKS + 50; i++) reg.block(id, { kind: "text", text: `line ${i}` });
		const blocks = reg.get(id)!.blocks;
		expect(blocks).toHaveLength(MAX_BLOCKS);
		// Oldest dropped: the last block is the newest.
		expect(blocks.at(-1)?.text).toBe(`line ${MAX_BLOCKS + 49}`);
	});

	it("settle marks a resident idle without ending it; finish overrides", () => {
		const reg = new LiveRunRegistry();
		const id = register(reg);
		reg.settle(id);
		expect(reg.get(id)?.status).toBe("idle");
		reg.setActivity(id, "back to work"); // idle → running on new activity
		expect(reg.get(id)?.status).toBe("running");
		reg.finish(id, true);
		expect(reg.get(id)?.status).toBe("failed");
		reg.settle(id); // no resurrecting a finished run
		expect(reg.get(id)?.status).toBe("failed");
	});

	it("lists newest-first", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "a", name: "a" });
		register(reg, { taskId: "b", name: "b" });
		expect(reg.list().map((r) => r.taskId)).toEqual(["b", "a"]);
	});
});

describe("buildRows", () => {
	it("prepends a synthetic main row reflecting main-busy", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "a" });
		const rows = buildRows(reg.list(), true);
		expect(rows[0].run).toBeUndefined();
		expect(rows[0].label).toBe("main");
		expect(rows[0].status).toBe("running");
		expect(rows[1].run?.taskId).toBe("a");
		expect(buildRows(reg.list(), false)[0].status).toBe("idle");
	});
});

describe("renderStrip", () => {
	const reg = new LiveRunRegistry();
	register(reg, { taskId: "a", agentType: "general-purpose" });
	reg.setActivity("a", "Reading tui-render.ts");
	reg.stats("a", 2, { input: 0, output: 58800, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
	const rows = buildRows(reg.list(), false);

	it("shows a focus hint only when focused, and marks the selection ●", () => {
		const unfocused = renderStrip({ rows, width: 80, now: 5000 }, paint).map(strip);
		expect(unfocused.some((l) => l.includes("to select"))).toBe(false);
		expect(unfocused[0]).toContain("○ main");

		const focused = renderStrip({ rows, selected: 1, width: 80, now: 5000 }, paint).map(strip);
		expect(focused[0]).toContain("to select");
		const agentRow = focused.find((l) => l.includes("general-purpose"))!;
		expect(agentRow).toContain("●");
		expect(agentRow).toContain("Reading tui-render.ts");
		expect(agentRow).toContain("58.8k");
	});

	it("collapses overflow past MAX_STRIP_ROWS", () => {
		const big = new LiveRunRegistry();
		for (let i = 0; i < MAX_STRIP_ROWS + 3; i++) register(big, { taskId: `t${i}`, name: `n${i}` });
		const out = renderStrip({ rows: buildRows(big.list(), false), width: 80, now: 5000 }, paint).map(strip);
		expect(out.some((l) => l.includes("more — /agents"))).toBe(true);
	});

	it("never emits an overwide line", () => {
		for (const line of renderStrip({ rows, selected: 0, width: 24, now: 5000 }, paint)) {
			expect([...strip(line)].length).toBeLessThanOrEqual(24);
		}
	});
});

describe("renderTranscript", () => {
	const reg = new LiveRunRegistry();
	const id = register(reg, { agentType: "general-purpose", task: "Efficiency review of diff" });
	reg.get(id)!.model = "sonnet-5";
	reg.get(id)!.thinking = "high";
	reg.stats(id, 2, { input: 0, output: 58800, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
	reg.block(id, { kind: "text", text: "You are a reviewer" });
	reg.block(id, { kind: "call", tool: "Read", text: "store.ts" });
	reg.block(id, { kind: "result", tool: "Read", text: "195 lines" });

	it("renders header identity, chip, blocks, and a live spinner while running", () => {
		const out = renderTranscript({ run: reg.get(id)!, width: 80, height: 20, scroll: 0, now: 4000 }, paint).map(strip);
		const joined = out.join("\n");
		expect(joined).toContain("general-purpose-1");
		expect(joined).toContain("Efficiency review of diff"); // chip
		expect(joined).toContain("general-purpose · sonnet-5 · high effort");
		expect(joined).toContain("Read(store.ts)");
		expect(joined).toContain("195 lines");
		expect(out.some((l) => /… \(/.test(l))).toBe(true); // spinner verb
		expect(joined).toContain("stop all");
	});

	it("shows a terminal line instead of a spinner once finished", () => {
		reg.finish(id, false);
		const out = renderTranscript({ run: reg.get(id)!, width: 80, height: 20, scroll: 0, now: 4000 }, paint).map(strip);
		expect(out.some((l) => l.includes("Completed"))).toBe(true);
	});

	it("never emits an overwide line at narrow widths", () => {
		for (const line of renderTranscript({ run: reg.get(id)!, width: 30, height: 12, scroll: 0, now: 4000 }, paint)) {
			expect([...strip(line)].length).toBeLessThanOrEqual(30);
		}
	});
});

describe("spinnerVerb", () => {
	it("advances over time and is stable within a 3s window", () => {
		expect(spinnerVerb(0, 0)).toBe(spinnerVerb(0, 2000));
		expect(spinnerVerb(0, 0)).not.toBe(spinnerVerb(0, 3000));
	});
});

describe("decodeStripKey", () => {
	it("maps arrows, enter, esc; ignores the rest", () => {
		expect(decodeStripKey("\x1b[A")).toBe("up");
		expect(decodeStripKey("\x1b[B")).toBe("down");
		expect(decodeStripKey("\r")).toBe("open");
		expect(decodeStripKey("\x1b")).toBe("leave");
		expect(decodeStripKey("a")).toBeUndefined();
	});
});

describe("decodeViewerKey", () => {
	it("decodes scroll/agent/stop/close keys", () => {
		expect(decodeViewerKey("\x1b[A", false).key).toBe("up");
		expect(decodeViewerKey("\t", false).key).toBe("nextAgent");
		expect(decodeViewerKey("\x1b[Z", false).key).toBe("prevAgent");
		expect(decodeViewerKey("x", false).key).toBe("stop");
		expect(decodeViewerKey("q", false).key).toBe("close");
		expect(decodeViewerKey("\x1b", false).key).toBe("close");
	});

	it("handles the ctrl+x ctrl+k stop-all chord", () => {
		const armed = decodeViewerKey("\x18", false);
		expect(armed.key).toBeUndefined();
		expect(armed.chordArmed).toBe(true);
		const done = decodeViewerKey("\x0b", true);
		expect(done.key).toBe("stopAll");
		expect(done.chordArmed).toBe(false);
	});

	it("cancels the chord on any non-ctrl+k key and decodes it fresh", () => {
		const after = decodeViewerKey("x", true);
		expect(after.key).toBe("stop");
		expect(after.chordArmed).toBe(false);
	});
});
