import { describe, expect, it } from "vitest";
import { ACTIVITY_CAP, AgentRecordStore, previewValue } from "../../extensions/workflow/records.ts";

const tick = (() => {
	let t = 1000;
	return () => t++;
})();

describe("previewValue", () => {
	it("passes strings through and caps long ones", () => {
		expect(previewValue("hello")).toBe("hello");
		expect(previewValue("x".repeat(3000), 10)).toBe(`${"x".repeat(10)}…`);
	});

	it("stringifies objects and handles undefined/circular", () => {
		expect(previewValue({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(previewValue(undefined)).toBe("(no value)");
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(previewValue(circular)).toBe("[object Object]");
	});
});

describe("AgentRecordStore", () => {
	it("folds start → update → end into one record", () => {
		const store = new AgentRecordStore(tick);
		store.apply({ type: "agentStart", callIndex: 0, label: "finder", phase: "Scan", prompt: "find bugs" });
		store.apply({ type: "agentUpdate", callIndex: 0, model: "claude-sonnet-5" });
		store.apply({ type: "agentUpdate", callIndex: 0, tool: { name: "grep", argsSummary: "TODO" } });
		store.apply({
			type: "agentEnd",
			callIndex: 0,
			label: "finder",
			tokens: { input: 10, output: 20, total: 30 },
			cost: 0.01,
			preview: "3 bugs",
		});

		const [record] = store.list();
		expect(record).toMatchObject({
			callIndex: 0,
			label: "finder",
			phase: "Scan",
			prompt: "find bugs",
			model: "claude-sonnet-5",
			status: "done",
			activity: [{ name: "grep", argsSummary: "TODO" }],
			outcome: "3 bugs",
			cost: 0.01,
		});
		expect(record.startedAt).toBeDefined();
		expect(record.finishedAt).toBeGreaterThan(record.startedAt as number);
	});

	it("creates a record from a replayed agentEnd alone (no agentStart)", () => {
		const store = new AgentRecordStore(tick);
		store.apply({
			type: "agentEnd",
			callIndex: 3,
			label: "cached",
			replayed: true,
			prompt: "the prompt",
			preview: "cached value",
		});
		const [record] = store.list();
		expect(record.status).toBe("replayed");
		expect(record.prompt).toBe("the prompt");
		expect(record.outcome).toBe("cached value");
	});

	it("marks a failed agent and keeps the message", () => {
		const store = new AgentRecordStore(tick);
		store.apply({ type: "agentStart", callIndex: 1, label: "worker", prompt: "do work" });
		store.apply({ type: "agentEnd", callIndex: 1, label: "worker", text: "failed: boom" });
		const [record] = store.list();
		expect(record.status).toBe("failed");
		expect(record.error).toBe("failed: boom");
	});

	it("caps activity and keeps the newest lines", () => {
		const store = new AgentRecordStore(tick);
		store.apply({ type: "agentStart", callIndex: 0, label: "busy", prompt: "spam tools" });
		for (let i = 0; i < ACTIVITY_CAP + 5; i++) {
			store.apply({ type: "agentUpdate", callIndex: 0, tool: { name: `tool-${i}` } });
		}
		const [record] = store.list();
		expect(record.activity).toHaveLength(ACTIVITY_CAP);
		expect(record.activity.at(-1)?.name).toBe(`tool-${ACTIVITY_CAP + 4}`);
		expect(record.activity[0]?.name).toBe("tool-5");
	});

	it("keeps a nested child's agents distinct from the parent's at the same callIndex", () => {
		const store = new AgentRecordStore(tick);
		store.apply({ type: "agentStart", callIndex: 0, label: "parent-agent", prompt: "summarize" });
		store.apply({
			type: "agentStart",
			callIndex: 0,
			label: "child-agent",
			prompt: "check style",
			source: "reviewChild",
			phase: "▸ reviewChild",
		});
		store.apply({ type: "agentEnd", callIndex: 0, label: "child-agent", source: "reviewChild", preview: "ok" });

		const records = store.list();
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({ label: "parent-agent", prompt: "summarize", status: "running" });
		expect(records[1]).toMatchObject({
			label: "child-agent",
			prompt: "check style",
			source: "reviewChild",
			status: "done",
			outcome: "ok",
		});
		expect(store.get(0)?.label).toBe("parent-agent");
		expect(store.get(0, "reviewChild")?.label).toBe("child-agent");
	});

	it("keeps first-seen order across interleaved agents and ignores non-agent events", () => {
		const store = new AgentRecordStore(tick);
		store.apply({ type: "phase", phase: "Scan" });
		store.apply({ type: "log", text: "starting" });
		store.apply({ type: "agentStart", callIndex: 2, label: "b", prompt: "task b" });
		store.apply({ type: "agentStart", callIndex: 0, label: "a", prompt: "task a" });
		store.apply({ type: "agentEnd", callIndex: 0, label: "a", preview: "done-a" });
		expect(store.list().map((r) => r.label)).toEqual(["b", "a"]);
		expect(store.get(2)?.status).toBe("running");
		expect(store.get(0)?.status).toBe("done");
	});
});
