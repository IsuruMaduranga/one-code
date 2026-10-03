import { describe, expect, it } from "vitest";
import tasksExtension from "../../extensions/tasks/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/** The task tools answer in Claude Code's words: the created task, and the fields an update changed. */
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

	it("task_create returns Claude Code's created text", async () => {
		const t = setup();
		expect((await t.create({ subject: "Read app.py", description: "" })).text).toBe("Task #1 created successfully: Read app.py");
	});

	it("task_update names the changed fields, and a deletion", async () => {
		const t = setup();
		await t.create({ subject: "A", description: "" });
		await t.create({ subject: "B", description: "" });
		expect((await t.update({ taskId: "#1", status: "in_progress" })).text).toBe("Updated task #1 status");
		expect((await t.update({ taskId: "2", subject: "B2", addBlockedBy: ["1"] })).text).toBe("Updated task #2 subject, blockedBy");
		expect((await t.update({ taskId: "2", status: "deleted" })).text).toBe("Updated task #2 deleted");
	});

	it("keeps the fail-loud errors: an unknown id names the fix", async () => {
		const t = setup();
		expect(await t.update({ taskId: "9", status: "completed" })).toEqual({ text: 'No task with id "9". Use task_list to see ids.', isError: true });
	});
});
