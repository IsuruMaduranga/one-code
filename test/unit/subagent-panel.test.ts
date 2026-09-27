import { describe, expect, it, vi } from "vitest";
import {
	deriveActivity,
	deriveLabel,
	LiveRunRegistry,
	MAX_BLOCKS,
	streamingText,
	type LiveRun,
} from "../../extensions/subagents/live-runs.ts";
import {
	buildRows,
	MAX_STRIP_ROWS,
	recentlyLeftStrip,
	renderStrip,
	renderTranscript,
	rowLabel,
	spinnerVerb,
	STRIP_LINGER_MS,
	TASKS_NOTICE,
} from "../../extensions/subagents/panel-render.ts";
import { userMessageForAgent } from "../../extensions/lib/agent-view.ts";
import { wrapProse } from "../../extensions/lib/tui-render.ts";
import { decodeStripKey } from "../../extensions/subagents/panel-keys.ts";
import { resolvePiTuiEntry } from "../../extensions/subagents/prose.ts";
import { existsSync } from "node:fs";

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
		expect(deriveLabel("x".repeat(80), "f")).toHaveLength(60); // cutPlainText: 59 + ellipsis
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
		expect(reg.get(id)?.blocks).toHaveLength(2); // task block + the appended call
		expect(changes).toBeGreaterThan(3);

		reg.finish(id, false);
		expect(reg.get(id)?.status).toBe("done");
		expect(reg.get(id)?.finishedAt).toBeGreaterThan(0);
	});

	it("opens the transcript with the task as a dim prompt block", () => {
		const reg = new LiveRunRegistry();
		const id = register(reg, { task: "Review the diff for efficiency" });
		expect(reg.get(id)?.blocks[0]).toEqual({ kind: "task", text: "Review the diff for efficiency" });
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

	it("stores the streaming message per delta and clears it on settle/finish", () => {
		const reg = new LiveRunRegistry();
		const id = register(reg);
		reg.setStreaming(id, { content: [{ type: "text", text: "Let me look" }] });
		expect(streamingText(reg.get(id)?.streaming)).toBe("Let me look");
		reg.setStreaming(id, { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Let me look at store.ts" }] });
		expect(streamingText(reg.get(id)?.streaming)).toBe("Let me look at store.ts");
		reg.finish(id, false);
		expect(reg.get(id)?.streaming).toBeUndefined();
	});

	it("supports multiple subscribers with unsubscribe", () => {
		const reg = new LiveRunRegistry();
		let a = 0;
		let b = 0;
		const offA = reg.subscribe(() => a++);
		reg.subscribe(() => b++);
		register(reg);
		expect(a).toBe(1);
		expect(b).toBe(1);
		offA();
		reg.setActivity("t1", "x");
		expect(a).toBe(1);
		expect(b).toBe(2);
	});

	it("reactivates a finished run for a resumed turn, appending the new prompt", () => {
		const reg = new LiveRunRegistry();
		const id = register(reg);
		reg.finish(id, false);
		expect(reg.reactivate(id, "Follow-up question", 9000)).toBe(true);
		const run = reg.get(id)!;
		expect(run.status).toBe("running");
		expect(run.startedAt).toBe(9000);
		expect(run.finishedAt).toBeUndefined();
		expect(run.blocks.at(-1)).toEqual({ kind: "task", text: "Follow-up question" });
		expect(reg.reactivate("never-seen", "x", 1)).toBe(false);
	});

	it("a resumed run's stats add on top of its lifetime totals (no visible regression)", () => {
		const reg = new LiveRunRegistry();
		const id = register(reg);
		reg.stats(id, 12, { input: 0, output: 5000, cacheRead: 0, cacheWrite: 0, total: 5000, cost: 0.5 });
		reg.finish(id, false);
		reg.reactivate(id, "again", 9000);
		// The resume's fresh tracker restarts at 0 — the first tick must not regress.
		reg.stats(id, 1, { input: 0, output: 50, cacheRead: 0, cacheWrite: 0, total: 50, cost: 0.01 });
		expect(reg.get(id)!.toolCalls).toBe(13);
		expect(reg.get(id)!.tokens.output).toBe(5050);
		expect(reg.get(id)!.tokens.cost).toBeCloseTo(0.51);
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

	it("finish('stopped') marks a user stop distinctly, not as completion or failure (TUI-REVIEW L1)", () => {
		const reg = new LiveRunRegistry();
		const id = register(reg);
		reg.finish(id, "stopped");
		const run = reg.get(id)!;
		expect(run.status).toBe("stopped");
		expect(run.activity).toBe("Stopped");
		const finishedAt = run.finishedAt!;
		expect(finishedAt).toBeGreaterThan(0);
		// A stopped run leaves the strip; viewed (pinned) it reads `idle`, and it
		// is not painted with the error token (STATUS_ROW_STYLE maps failed → error).
		expect(buildRows(reg.list(), false).map((r) => r.run?.taskId)).toEqual([undefined]);
		const lines = renderStrip({ rows: buildRows(reg.list(), false, id), viewedId: id, width: 60, now: finishedAt }, paint);
		expect(lines.some((line) => strip(line).includes("idle"))).toBe(true);
		expect(lines.every((line) => !line.includes("fg:error"))).toBe(true);
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

	it("nests a child-spawned run under its parent in spawn order (CC's tree)", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "parent", name: "parent" });
		reg.register({ taskId: "kid1", name: "kid1", agentType: "explore", task: "t", startedAt: 2000, parentTaskId: "parent", depth: 1 });
		reg.register({ taskId: "kid2", name: "kid2", agentType: "explore", task: "t", startedAt: 3000, parentTaskId: "parent", depth: 1 });
		register(reg, { taskId: "other", name: "other" });
		const rows = buildRows(reg.list(), false);
		expect(rows.map((r) => [r.run?.taskId, r.depth])).toEqual([
			[undefined, 0], // main
			["other", 0], // roots newest-first
			["parent", 0],
			["kid1", 1], // nested spawns in spawn order
			["kid2", 1],
		]);
	});

	it("surfaces a nested run at root level when its parent left the strip", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "parent", name: "parent" });
		reg.register({ taskId: "kid", name: "kid", agentType: "explore", task: "t", startedAt: 2000, parentTaskId: "parent", depth: 1 });
		reg.finish("parent", false);
		reg.get("parent")!.finishedAt = 1000; // linger long expired
		const rows = buildRows(reg.list(), false);
		expect(rows.map((r) => [r.run?.taskId, r.depth])).toEqual([
			[undefined, 0],
			["kid", 0], // orphan promoted, not vanished
		]);
	});

	it("drops settled runs (done AND idle residents) at once, as Claude Code does; keeps running ones", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "done1", name: "done1" });
		register(reg, { taskId: "idle1", name: "idle1" });
		register(reg, { taskId: "live1", name: "live1" });
		reg.settle("idle1");
		reg.finish("done1", false);
		reg.get("done1")!.finishedAt = 10_000;
		reg.get("idle1")!.finishedAt = 10_000;
		expect(buildRows(reg.list(), false).map((r) => r.run?.taskId)).toEqual([undefined, "live1"]);
		// The runs stay in the registry (the viewer, /tasks, /agents and SendMessage reach them).
		expect(reg.get("done1")).toBeDefined();
		expect(reg.get("idle1")).toBeDefined();
	});

	it("says `/tasks to see subagents` for a moment after a run leaves the strip", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "done1", name: "done1" });
		reg.finish("done1", false);
		reg.get("done1")!.finishedAt = 10_000;
		expect(recentlyLeftStrip(reg.list(), 10_000 + STRIP_LINGER_MS - 1)).toBe(true);
		expect(recentlyLeftStrip(reg.list(), 10_000 + STRIP_LINGER_MS + 1)).toBe(false);
		// The viewed run has not left the strip.
		expect(recentlyLeftStrip(reg.list(), 10_001, "done1")).toBe(false);
		expect(TASKS_NOTICE).toBe("/tasks to see subagents");
	});

	it("a woken idle resident rejoins the strip (finishedAt cleared)", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "r1", name: "r1" });
		reg.settle("r1");
		reg.get("r1")!.finishedAt = 10_000;
		reg.setActivity("r1", "Reading store.ts"); // steered into a new turn
		const rows = buildRows(reg.list(), false).map((r) => r.run?.taskId);
		expect(rows).toEqual([undefined, "r1"]);
		expect(reg.get("r1")!.status).toBe("running");
		expect(reg.get("r1")!.finishedAt).toBeUndefined();
	});

	it("pins the viewed run in the strip past its linger window (open-transcript case)", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "viewed", name: "viewed" });
		reg.finish("viewed", false);
		reg.get("viewed")!.finishedAt = 10_000;
		const now = 10_000 + STRIP_LINGER_MS + 1;
		// Lingered out normally…
		expect(buildRows(reg.list(), false).map((r) => r.run?.taskId)).toEqual([undefined]);
		// …but stays while its transcript is the pinned (open) one.
		expect(buildRows(reg.list(), false, "viewed").map((r) => r.run?.taskId)).toEqual([undefined, "viewed"]);
	});
});

describe("renderStrip", () => {
	const reg = new LiveRunRegistry();
	register(reg, { taskId: "a", agentType: "general-purpose" });
	reg.setActivity("a", "Reading tui-render.ts");
	reg.stats("a", 2, { input: 0, output: 58800, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
	const rows = buildRows(reg.list(), false);

	it("shows Claude Code's focus hint only when focused, and marks the selection ❯", () => {
		const unfocused = renderStrip({ rows, width: 80, now: 5000 }, paint).map(strip);
		expect(unfocused.some((l) => l.includes("Enter to view"))).toBe(false);
		// Unfocused: no selection caret on any row; main is the row on screen.
		expect(unfocused.some((l) => l.includes("❯"))).toBe(false);
		expect(unfocused[0]).toContain("⏺ main");

		const focused = renderStrip({ rows, selected: 1, width: 80, now: 5000 }, paint).map(strip);
		expect(focused[0]).toBe("Enter to view · x to stop · ctrl+x ctrl+k stop all · esc back");
		const agentRow = focused.find((l) => l.includes("general-purpose"))!;
		expect(agentRow).toMatch(/^❯ ◯ general-purpose {2}/);
		expect(agentRow).toContain("58.8k");

		// Viewing the agent: ↑/↓ selects, and the viewed row carries the filled dot.
		const viewing = renderStrip({ rows, selected: 0, viewedId: "a", width: 80, now: 5000 }, paint).map(strip);
		expect(viewing[0]).toBe("↑/↓ to select · Enter to view · ctrl+x ctrl+k stop all · esc back");
		expect(viewing.find((l) => l.includes("general-purpose"))).toContain("⏺ general-purpose");
		expect(viewing.find((l) => l.includes("main"))).toContain("◯ main");
	});

	it("labels a fork by its name and any other run by its type, then its description", () => {
		const reg = new LiveRunRegistry();
		reg.register({ taskId: "f", name: "what-word-is", agentType: "fork", task: "what word is in the file?", description: "what word is in the file?", startedAt: 1000 });
		const out = renderStrip({ rows: buildRows(reg.list(), false), width: 100, now: 5000 }, paint).map(strip);
		expect(out.find((l) => l.includes("what-word-is"))).toMatch(/◯ what-word-is {2}what word is in the file\?/);
		expect(rowLabel({ agentType: "general-purpose", name: "general-purpose-1" })).toBe("general-purpose");
	});

	it("indents nested rows with the └ elbow", () => {
		const reg = new LiveRunRegistry();
		register(reg, { taskId: "p", name: "p", agentType: "code-review" });
		reg.register({ taskId: "k", name: "k", agentType: "general-purpose", task: "verify widget", startedAt: 2000, parentTaskId: "p", depth: 1 });
		const out = renderStrip({ rows: buildRows(reg.list(), false), width: 100, now: 5000 }, paint).map(strip);
		expect(out.find((l) => l.includes("code-review"))).not.toContain("└");
		expect(out.find((l) => l.includes("general-purpose"))).toMatch(/└ ◯ general-purpose/);
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

describe("wrapProse", () => {
	it("wraps at word boundaries, preserving blank lines", () => {
		expect(wrapProse("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
		expect(wrapProse("para one\n\npara two", 20)).toEqual(["para one", "", "para two"]);
	});
	it("hard-breaks only words wider than the width", () => {
		expect(wrapProse("see /a/very/long/path.ts now", 12)).toEqual(["see", "/a/very/long", "/path.ts now"]);
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
		const out = renderTranscript({ run: reg.get(id)!, width: 80, height: 20, scroll: 0, now: 4000 }, paint).lines.map(strip);
		const joined = out.join("\n");
		expect(joined).toContain("general-purpose-1");
		expect(joined).toContain("Efficiency review of diff"); // chip + task block
		expect(joined).toContain("general-purpose · sonnet-5 · high effort");
		expect(joined).toContain("Read(store.ts)");
		expect(joined).toContain("195 lines");
		expect(out.some((l) => /… \(/.test(l))).toBe(true); // spinner verb
	});

	it("streams the in-flight assistant text after the settled blocks, wrapped", () => {
		reg.setStreaming(id, { content: [{ type: "text", text: "I found three efficiency issues worth flagging in the diff" }] });
		const out = renderTranscript({ run: reg.get(id)!, width: 30, height: 24, scroll: 0, now: 4000 }, paint).lines.map(strip);
		const joined = out.join("\n");
		expect(joined).toContain("I found three efficiency");
		expect(joined).toContain("issues worth flagging in the");
		reg.setStreaming(id, undefined);
	});

	it("returns exactly `height` lines, even below the header's natural size", () => {
		for (const height of [5, 8, 12, 20]) {
			expect(renderTranscript({ run: reg.get(id)!, width: 80, height, scroll: 0, now: 4000 }, paint).lines).toHaveLength(height);
		}
	});

	it("anchors the window to the tail and reports maxScroll for clamping", () => {
		const tail = new LiveRunRegistry();
		const tid = register(tail, { task: "" });
		for (let i = 0; i < 40; i++) tail.block(tid, { kind: "call", tool: "Read", text: `f${i}.ts` });
		const followed = renderTranscript({ run: tail.get(tid)!, width: 80, height: 14, scroll: 0, now: 4000 }, paint);
		expect(followed.lines.map(strip).join("\n")).toContain("Read(f39.ts)"); // newest visible at scroll 0
		expect(followed.maxScroll).toBeGreaterThan(0);
		const back = renderTranscript({ run: tail.get(tid)!, width: 80, height: 14, scroll: followed.maxScroll, now: 4000 }, paint);
		const backJoined = back.lines.map(strip).join("\n");
		expect(backJoined).toContain("Read(f0.ts)"); // scrolled fully back to the head
		expect(backJoined).not.toContain("Read(f39.ts)");
	});

	it("surfaces a scroll affordance on the bottom row only when the body overflows", () => {
		const tall = new LiveRunRegistry();
		const tid = register(tall, { task: "" });
		for (let i = 0; i < 40; i++) tall.block(tid, { kind: "call", tool: "Read", text: `f${i}.ts` });
		// Overflowing body → a "PgUp/PgDn scroll" affordance on the bottom row (↑/↓ select agents).
		const overflowing = renderTranscript({ run: tall.get(tid)!, width: 80, height: 14, scroll: 0, now: 4000 }, paint).lines.map(strip);
		expect(overflowing.at(-1)).toContain("PgUp/PgDn scroll");
		// A short transcript that fits shows no scroll affordance.
		const short = renderTranscript({ run: reg.get(id)!, width: 80, height: 40, scroll: 0, now: 4000 }, paint).lines.map(strip);
		expect(short.some((l) => l.includes("PgUp/PgDn scroll"))).toBe(false);
	});

	it("opens a fork's view with `⑂ <question>` and shows the user's messages as `❯` rows", () => {
		const forks = new LiveRunRegistry();
		forks.register({ taskId: "f", name: "what-word-is", agentType: "fork", task: "what word is in the file?", startedAt: 1000 });
		forks.settle("f");
		forks.reactivate("f", userMessageForAgent("now give it a title"), 2000);
		const out = renderTranscript({ run: forks.get("f")!, width: 80, height: 20, scroll: 0, now: 3000 }, paint).lines.map(strip);
		expect(out).toContain("⑂ what word is in the file?");
		expect(out).toContain("❯ now give it a title");
		expect(out.join("\n")).not.toContain("The user sent a new message");
	});

	it("fills to exactly `height` lines with the live status at the bottom edge (overlay must paint every row)", () => {
		const out = renderTranscript({ run: reg.get(id)!, width: 80, height: 24, scroll: 0, now: 4000 }, paint);
		expect(out.lines).toHaveLength(24);
		expect(strip(out.lines.at(-1)!)).toMatch(/… \(/); // running spinner (key hints live in the strip)
	});

	it("routes text blocks and the streaming tail through the injected prose renderer", () => {
		const refs: Array<object | string> = [];
		const prose = (ref: object | string, text: string, width: number) => {
			refs.push(ref);
			return [`MD:${text.slice(0, width - 3)}`];
		};
		reg.setStreaming(id, { content: [{ type: "text", text: "partial words" }] });
		const out = renderTranscript({ run: reg.get(id)!, width: 80, height: 20, scroll: 0, now: 4000, prose }, paint).lines.map(strip);
		expect(out.some((l) => l.includes("MD:You are a reviewer"))).toBe(true);
		expect(out.some((l) => l.includes("MD:partial words"))).toBe(true);
		// The settled block passes itself (stable cache key); the tail a per-run string.
		expect(refs).toContain(reg.get(id)!.blocks.find((b) => b.kind === "text"));
		expect(refs).toContain(`stream:${id}`);
		// The task prompt stays plain-dim, never markdown.
		expect(out.some((l) => l.includes("MD:Efficiency review"))).toBe(false);
		reg.setStreaming(id, undefined);
	});

	it("shows a terminal line instead of a spinner once finished", () => {
		reg.finish(id, false);
		const out = renderTranscript({ run: reg.get(id)!, width: 80, height: 20, scroll: 0, now: 4000 }, paint).lines.map(strip);
		expect(out.some((l) => l.includes("Completed"))).toBe(true);
	});

	it("never emits an overwide line at narrow widths", () => {
		for (const line of renderTranscript({ run: reg.get(id)!, width: 30, height: 12, scroll: 0, now: 4000 }, paint).lines) {
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

describe("resolvePiTuiEntry", () => {
	it("locates pi's own pi-tui entry file (nested or hoisted) without require.resolve", () => {
		const entry = resolvePiTuiEntry();
		expect(entry).toContain("pi-tui");
		expect(existsSync(entry)).toBe(true);
	});
});

describe("decodeStripKey", () => {
	it("maps arrows, enter, esc, x, page keys; typing decodes to nothing", () => {
		expect(decodeStripKey("\x1b[A", false).key).toBe("up");
		expect(decodeStripKey("\x1b[B", false).key).toBe("down");
		expect(decodeStripKey("\r", false).key).toBe("open");
		expect(decodeStripKey("\x1b", false).key).toBe("leave");
		expect(decodeStripKey("x", false).key).toBe("stop");
		expect(decodeStripKey("\x1b[5~", false).key).toBe("pageUp");
		expect(decodeStripKey("\x1b[6~", false).key).toBe("pageDown");
		expect(decodeStripKey("a", false).key).toBeUndefined();
		// Tab is `switch` — index.ts acts on it only while a transcript view is
		// open (retarget to the next agent); with no view open the agents branch
		// treats it like typing. Right still decodes to nothing; left and space
		// decode (the shell stages use them).
		expect(decodeStripKey("\t", false).key).toBeUndefined(); // Tab is typing (no next-agent key)
		expect(decodeStripKey("\x1b[C", false).key).toBeUndefined();
		expect(decodeStripKey("\x1b[D", false).key).toBe("left");
		expect(decodeStripKey(" ", false).key).toBe("space");
	});

	it("handles the ctrl+x ctrl+k stop-all chord", () => {
		const armed = decodeStripKey("\x18", false);
		expect(armed.key).toBeUndefined();
		expect(armed.chordArmed).toBe(true);
		const done = decodeStripKey("\x0b", true);
		expect(done.key).toBe("stopAll");
		expect(done.chordArmed).toBe(false);
	});

	it("cancels the chord on any non-ctrl+k key and decodes it fresh", () => {
		const after = decodeStripKey("x", true);
		expect(after.key).toBe("stop");
		expect(after.chordArmed).toBe(false);
	});
});

// pi replaces the session (and this extension instance) on /clear, /new and
// /resume, then invalidates the old ctx so every getter throws. Children killed
// at that shutdown keep emitting registry changes for a moment; a timer that
// painted on the stale ctx crashed the whole process (SUBAGENT-REVIEW H1).
describe("SubagentWidget after dispose", () => {
	const makeCtx = (state: { stale: boolean; setWidget: (key: string, value: unknown) => void }) =>
		({
			get hasUI() {
				if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				return true;
			},
			isIdle() {
				if (state.stale) throw new Error("stale");
				return true;
			},
			ui: { setWidget: state.setWidget },
		}) as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

	it("stops scheduling, ticking and painting once disposed, even when the ctx has gone stale", async () => {
		const { SubagentWidget } = await import("../../extensions/subagents/panel-widget.ts");
		vi.useFakeTimers();
		try {
			const calls: Array<[string, unknown]> = [];
			const state = { stale: false, setWidget: (key: string, value: unknown) => calls.push([key, value]) };
			const registry = new LiveRunRegistry();
			const widget = new SubagentWidget(registry, () => makeCtx(state));
			registry.register({ taskId: "t1", name: "explore-1", agentType: "explore", task: "look", startedAt: Date.now() });
			vi.advanceTimersByTime(300);
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.at(-1)?.[1]).not.toBeUndefined(); // strip rendered

			widget.dispose();
			expect(widget.isDisposed).toBe(true);
			expect(calls.at(-1)?.[1]).toBeUndefined(); // widget removed on dispose
			const painted = calls.length;

			// The session is replaced: the ctx now throws; the dying child still reports.
			state.stale = true;
			registry.block("t1", { kind: "text", text: "bye" });
			registry.finish("t1", true);
			expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
			expect(calls.length).toBe(painted); // nothing painted after dispose
		} finally {
			vi.useRealTimers();
		}
	});

	it("treats a ctx whose getters throw as no UI even before dispose", async () => {
		const { SubagentWidget } = await import("../../extensions/subagents/panel-widget.ts");
		vi.useFakeTimers();
		try {
			const state = { stale: true, setWidget: () => {} };
			const registry = new LiveRunRegistry();
			new SubagentWidget(registry, () => makeCtx(state));
			registry.register({ taskId: "t2", name: "plan-1", agentType: "plan", task: "plan", startedAt: Date.now() });
			expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});
