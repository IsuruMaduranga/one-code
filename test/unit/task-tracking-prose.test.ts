import { describe, expect, it } from "vitest";
import { DOING_TASKS } from "../../extensions/system-prompt/tiers/mid.ts";
import { USING_TOOLS } from "../../extensions/system-prompt/tiers/low.ts";

/**
 * The verbose and tiny prompt registers each carry a line steering the model to
 * plan and track multi-step work. It used to name a "todo tool" that does not
 * exist — the real tools are `task_create`/`task_update`, deferred behind
 * tool_search (TOOL-FIDELITY-REVIEW-2026-09-07 H2). A literal model that reads
 * "todo tool" finds nothing and gives up on tracking, so this guards against a
 * stale name creeping back after a tool rename.
 */
const REGISTERS = {
	DOING_TASKS,
	USING_TOOLS,
};

describe("task-tracking prose names a real tool", () => {
	for (const [name, text] of Object.entries(REGISTERS)) {
		it(`${name} names task_create and tells the model to load it`, () => {
			expect(text).not.toMatch(/todo tool/i);
			expect(text).toContain("task_create");
			// The tool is deferred, so the steer must point at how to load it.
			expect(text).toContain("tool_search");
		});
	}
});
