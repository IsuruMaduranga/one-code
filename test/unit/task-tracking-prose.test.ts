import { describe, expect, it } from "vitest";
import { USING_TOOLS as LONG_USING_TOOLS, USING_TOOLS_WITHOUT_TASK_TOOLS } from "../../extensions/system-prompt/tiers/mid.ts";
import { USING_TOOLS } from "../../extensions/system-prompt/tiers/low.ts";

/**
 * The long and tiny prompt registers each carry a line steering the model to
 * plan and track multi-step work. It used to name a "todo tool" that does not
 * exist — the real tools are `task_create`/`task_update`, deferred behind
 * tool_search (TOOL-FIDELITY-REVIEW-2026-09-07 H2). A literal model that reads
 * "todo tool" finds nothing and gives up on tracking, so this guards against a
 * stale name creeping back after a tool rename. The long register keeps Claude
 * Code's one-line wording (the deferred listing says how to load the tool);
 * tiny's own line also names the load.
 */
const REGISTERS = {
	LONG_USING_TOOLS,
	USING_TOOLS,
};

describe("task-tracking prose names a real tool", () => {
	for (const [name, text] of Object.entries(REGISTERS)) {
		it(`${name} names task_create`, () => {
			expect(text).not.toMatch(/todo tool/i);
			expect(text).toContain("task_create");
		});
	}

	it("tiny's line tells the model how to load the deferred tool", () => {
		expect(USING_TOOLS).toContain("tool_search select:task_create");
	});

	it("the long register drops its task line for a model without the task tools", () => {
		expect(USING_TOOLS_WITHOUT_TASK_TOOLS).not.toContain("task_create");
		expect(LONG_USING_TOOLS.replace(/\n - Use task_create[^\n]*/, "")).toBe(USING_TOOLS_WITHOUT_TASK_TOOLS);
	});
});
