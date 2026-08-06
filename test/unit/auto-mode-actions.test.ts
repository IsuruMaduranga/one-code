import { describe, expect, it } from "vitest";
import { type ChildAction, recordAction, renderActions } from "../../extensions/auto-mode/actions.ts";

describe("recordAction", () => {
	it("records the tool name and its subject", () => {
		const log: ChildAction[] = [];
		recordAction(log, "bash", { command: "npm test" });
		recordAction(log, "read", { file_path: "/repo/src/a.ts" });
		expect(log).toEqual([
			{ toolName: "bash", subject: "npm test" },
			{ toolName: "read", subject: "/repo/src/a.ts" },
		]);
	});

	it("never records tool output, only the call's own subject", () => {
		// Output is untrusted content; feeding it to the classifier is the exact
		// injection path auto mode exists to close.
		const log: ChildAction[] = [];
		recordAction(log, "bash", { command: "cat secrets", output: "SECRET", result: "SECRET" });
		expect(JSON.stringify(log)).not.toContain("SECRET");
	});

	it("clips a long subject", () => {
		const log: ChildAction[] = [];
		recordAction(log, "bash", { command: "x".repeat(1000) });
		expect(log[0].subject.length).toBeLessThanOrEqual(160);
	});

	it("caps the log so a long-running child cannot blow up the prompt", () => {
		const log: ChildAction[] = [];
		for (let i = 0; i < 500; i++) recordAction(log, "read", { path: `f${i}.ts` });
		expect(log.length).toBeLessThanOrEqual(60);
	});

	it("tolerates a call with no recognisable subject", () => {
		const log: ChildAction[] = [];
		recordAction(log, "todo_write", { todos: [] });
		expect(log[0]).toEqual({ toolName: "todo_write", subject: "" });
	});
});

describe("renderActions", () => {
	it("lists actions one per line", () => {
		expect(renderActions([{ toolName: "bash", subject: "ls" }, { toolName: "read", subject: "a.ts" }])).toBe(
			"bash: ls\nread: a.ts",
		);
	});

	it("collapses consecutive repeats so 40 identical reads read as one line", () => {
		const actions = Array.from({ length: 40 }, () => ({ toolName: "read", subject: "a.ts" }));
		expect(renderActions(actions)).toBe("read: a.ts (×40)");
	});

	it("keeps distinct runs separate", () => {
		const actions = [
			{ toolName: "read", subject: "a.ts" },
			{ toolName: "read", subject: "a.ts" },
			{ toolName: "bash", subject: "npm test" },
			{ toolName: "read", subject: "a.ts" },
		];
		expect(renderActions(actions)).toBe("read: a.ts (×2)\nbash: npm test\nread: a.ts");
	});

	it("omits an empty subject", () => {
		expect(renderActions([{ toolName: "todo_write", subject: "" }])).toBe("todo_write");
	});

	it("returns empty for no actions", () => {
		expect(renderActions([])).toBe("");
	});
});
