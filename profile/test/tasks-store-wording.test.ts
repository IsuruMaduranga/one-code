/**
 * One Code's wording of the task tools' texts (its profile's `tasks` group):
 * the task reminder, the list and details, and an update's problems. The
 * store behind them is tested in test/unit/tasks-store.test.ts.
 */
import { describe, expect, it } from "vitest";
import { TaskStore, taskView } from "../../extensions/tools/tasks/store.ts";
import { tasks as text } from "../text/tasks/index.ts";

describe("One Code's task texts", () => {
	it("words a self-reference apart from an unknown dependency id", () => {
		const store = new TaskStore();
		const a = store.create({ subject: "A", description: "" });
		expect(text.updated({ id: a.id, fields: [], problems: [{ kind: "selfReference", id: a.id }] })).toContain("cannot block or be blocked by itself");
	});

	it("emits Claude Code's task_reminder with the current list appended", () => {
		const store = new TaskStore();
		// Empty list → the generic nudge, no appended task list.
		const empty = text.reminder(store.list());
		expect(empty).toContain("The task tools haven't been used recently");
		expect(empty).toContain("cleaning up the task list if it has become stale");
		expect(empty).toContain("NEVER mention this reminder to the user");
		expect(empty).not.toContain("Here are the existing tasks");

		const a = store.create({ subject: "A", description: "" });
		const b = store.create({ subject: "B", description: "" });
		store.update(a.id, { status: "in_progress" });
		store.update(b.id, { status: "completed" });
		// Same text regardless of state — the appended list carries the state.
		const withTasks = text.reminder(store.list());
		expect(withTasks).toContain("The task tools haven't been used recently");
		expect(withTasks).toContain("Here are the existing tasks:");
		expect(withTasks).toContain(`#${a.id}. [in_progress] A`);
		expect(withTasks).toContain(`#${b.id}. [completed] B`);
	});

	it("formats list and details", () => {
		const store = new TaskStore();
		const a = store.create({ subject: "Build", description: "the thing" });
		store.update(a.id, { status: "in_progress" });
		expect(text.list(store.list().map((task) => taskView(store, task)))).toContain("#1 [▸] Build");
		expect(text.details(taskView(store, store.get(a.id)!))).toContain("Description: the thing");
		expect(text.list([])).toBe("No tasks.");
	});
});
