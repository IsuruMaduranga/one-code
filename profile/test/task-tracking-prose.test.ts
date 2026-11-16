import { describe, expect, it } from "vitest";
import { TASK_LINE, USING_TOOLS as LONG_USING_TOOLS, USING_TOOLS_WITH_TASK_TOOLS as LONG_WITH_TASKS } from "../text/system-prompt/mid.ts";
import { LOW_TASK_LINE, USING_TOOLS, USING_TOOLS_WITH_TASK_TOOLS } from "../text/system-prompt/low.ts";
import { TASK_CREATE_DESCRIPTION } from "../text/tasks/descriptions.ts";

/**
 * The long and tiny prompt registers carry a task bullet only in a session
 * the ENABLE_TODO_TOOLS knob gives the task tools. It names the real tools,
 * `task_create`/`task_update`, deferred behind tool_search: an older line named
 * a "todo tool" that does not exist (TOOL-FIDELITY-REVIEW-2026-09-07 H2), and a
 * literal model that reads it finds nothing. The bullet keeps the list for
 * long work and the user's own lists: a directive to plan every multi-step
 * task made models keep needless lists.
 */
const REGISTERS = { LONG_WITH_TASKS, USING_TOOLS_WITH_TASK_TOOLS };

describe("task-tracking prose", () => {
	for (const [name, text] of Object.entries(REGISTERS)) {
		it(`${name} names task_create and how to load it`, () => {
			expect(text).not.toMatch(/todo tool/i);
			expect(text).toContain("tool_search select:task_create,task_update");
		});
	}

	it("is absent from the default registers", () => {
		expect(LONG_USING_TOOLS).not.toContain("task_create");
		expect(USING_TOOLS).not.toContain("task_create");
		expect(LONG_WITH_TASKS.replace(`\n${TASK_LINE}`, "")).toBe(LONG_USING_TOOLS);
		expect(USING_TOOLS_WITH_TASK_TOOLS.replace(`\n${LOW_TASK_LINE}`, "")).toBe(USING_TOOLS);
	});

	it("keeps the list for long work and the user's own lists, not ordinary tasks", () => {
		for (const line of [TASK_LINE, LOW_TASK_LINE]) {
			expect(line).toContain("only for work that will take many separate steps over a long session, or for a list of requests from the user");
			expect(line).toContain("For ordinary tasks, do the work without one.");
			expect(line).toMatch(/When a list exists, mark each task completed as soon as it/);
			expect(line).not.toContain("—");
		}
		expect(TASK_CREATE_DESCRIPTION).not.toContain("proactively");
		expect(TASK_CREATE_DESCRIPTION).not.toContain("3 or more distinct steps");
		expect(TASK_CREATE_DESCRIPTION).toContain("- Long multi-step work - When the work will take many separate steps over a long session");
		expect(TASK_CREATE_DESCRIPTION).toContain("NOTE that for ordinary tasks you are better off doing the work directly, without a task list.");
	});
});
