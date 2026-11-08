/** One Code's wording for a skill call (profile/text/skill/). The base's skill invocation is in test/unit/skill-invoke.test.ts. */
import { describe, expect, it } from "vitest";
import { skill } from "../text/skill/index.ts";

describe("One Code's skill call text", () => {
	it("answers a model's call with Claude Code's launch line", () => {
		expect(skill.launching("workflow-authoring")).toBe("Launching skill: workflow-authoring");
	});
});
