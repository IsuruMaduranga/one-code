import { describe, expect, it } from "vitest";
import { formatTaskDetails, formatTaskList, TaskStore } from "../../extensions/tasks/store.ts";

describe("TaskStore", () => {
	it("creates tasks with incrementing ids and pending status", () => {
		const store = new TaskStore();
		const a = store.create({ subject: "A", description: "first" });
		const b = store.create({ subject: "B", description: "second" });
		expect([a.id, b.id]).toEqual(["1", "2"]);
		expect(a.status).toBe("pending");
	});

	it("updates fields and merges metadata with null-deletes", () => {
		const store = new TaskStore();
		const task = store.create({ subject: "A", description: "d", metadata: { keep: 1, drop: 2 } });
		store.update(task.id, { status: "in_progress", owner: "me", metadata: { drop: null, added: true } });
		const updated = store.get(task.id)!;
		expect(updated.status).toBe("in_progress");
		expect(updated.owner).toBe("me");
		expect(updated.metadata).toEqual({ keep: 1, added: true });
	});

	it("keeps dependency links reciprocal in both directions", () => {
		const store = new TaskStore();
		const a = store.create({ subject: "A", description: "" });
		const b = store.create({ subject: "B", description: "" });
		const c = store.create({ subject: "C", description: "" });
		store.update(a.id, { addBlocks: [b.id] });
		store.update(c.id, { addBlockedBy: [a.id] });
		expect(store.get(a.id)!.blocks.sort()).toEqual([b.id, c.id].sort());
		expect(store.get(b.id)!.blockedBy).toEqual([a.id]);
		expect(store.get(c.id)!.blockedBy).toEqual([a.id]);
	});

	it("treats completed and deleted blockers as resolved", () => {
		const store = new TaskStore();
		const blocker = store.create({ subject: "A", description: "" });
		const blocked = store.create({ subject: "B", description: "" });
		store.update(blocked.id, { addBlockedBy: [blocker.id] });
		expect(store.openBlockers(store.get(blocked.id)!)).toEqual([blocker.id]);
		store.update(blocker.id, { status: "completed" });
		expect(store.openBlockers(store.get(blocked.id)!)).toEqual([]);
	});

	it("deleting a task removes it and strips it from other tasks' links", () => {
		const store = new TaskStore();
		const a = store.create({ subject: "A", description: "" });
		const b = store.create({ subject: "B", description: "" });
		store.update(a.id, { addBlocks: [b.id] });
		const outcome = store.update(a.id, { status: "deleted" });
		expect(outcome.deleted).toBe(true);
		expect(store.get(a.id)).toBeUndefined();
		expect(store.get(b.id)!.blockedBy).toEqual([]);
	});

	it("reports unknown ids and unknown dependency targets", () => {
		const store = new TaskStore();
		expect(store.update("99", { status: "completed" }).error).toContain("99");
		const a = store.create({ subject: "A", description: "" });
		expect(store.update(a.id, { addBlocks: ["7"] }).error).toContain("7");
	});

	it("round-trips through snapshot/restore preserving the id counter", () => {
		const store = new TaskStore();
		store.create({ subject: "A", description: "" });
		const snapshot = store.snapshot();
		const restored = new TaskStore();
		restored.restore(snapshot);
		expect(restored.create({ subject: "B", description: "" }).id).toBe("2");
		expect(restored.get("1")!.subject).toBe("A");
	});

	it("formats list and details", () => {
		const store = new TaskStore();
		const a = store.create({ subject: "Build", description: "the thing" });
		store.update(a.id, { status: "in_progress" });
		expect(formatTaskList(store)).toContain("#1 [▸] Build");
		expect(formatTaskDetails(store, store.get(a.id)!)).toContain("Description: the thing");
		expect(formatTaskList(new TaskStore())).toBe("No tasks.");
	});
});
