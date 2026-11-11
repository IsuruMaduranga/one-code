import { describe, expect, it } from "vitest";
import tasksExtension from "../../extensions/tools/tasks/index.ts";
import { TaskStore } from "../../extensions/tools/tasks/store.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { tasksResultText } from "../../extensions/tools/tasks/text.ts";

/**
 * The task tools answer with what happened: the created task, the fields an
 * update changed (ids normalized), a deletion, and an unknown id as an error.
 * The wording is tested in tasks-results-wording.test.ts.
 */
describe("tasks: result texts", () => {
	const setup = () => {
		const fake = createFakePi();
		tasksExtension(fake.pi as never);
		const ctx = createFakeCtx();
		const run = (name: string) => async (params: Record<string, unknown>) => {
			const result = (await fake.tools.get(name)!.execute("call", params, undefined, undefined, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
			return { text: result.content[0]?.text, isError: result.isError };
		};
		return { create: run("task_create"), update: run("task_update") };
	};

	it("task_create returns the profile's created text for the new task", async () => {
		const t = setup();
		// The same store code builds the task the tool created.
		const expected = new TaskStore().create({ subject: "Read app.py", description: "" });
		expect((await t.create({ subject: "Read app.py", description: "" })).text).toBe(tasksResultText.created(expected));
	});

	it("task_update names the changed fields, and a deletion", async () => {
		const t = setup();
		await t.create({ subject: "A", description: "" });
		await t.create({ subject: "B", description: "" });
		expect((await t.update({ taskId: "#1", status: "in_progress" })).text).toBe(tasksResultText.updated({ id: "1", fields: ["status"], problems: [] }));
		expect((await t.update({ taskId: "2", subject: "B2", addBlockedBy: ["1"] })).text).toBe(tasksResultText.updated({ id: "2", fields: ["subject", "blockedBy"], problems: [] }));
		expect((await t.update({ taskId: "2", status: "deleted" })).text).toBe(tasksResultText.deleted("2"));
	});

	it("keeps the fail-loud errors: an unknown id is an error", async () => {
		const t = setup();
		expect(await t.update({ taskId: "9", status: "completed" })).toEqual({ text: tasksResultText.notFound("9"), isError: true });
	});
});
