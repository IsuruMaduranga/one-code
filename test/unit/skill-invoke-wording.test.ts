/** The wording of a skill call's result. The invocation: skill-invoke.test.ts. */
import { describe, expect, it } from "vitest";
import { skillResultText } from "../../extensions/tools/skill/text.ts";

describe("the skill call text", () => {
	it("answers a model's call with Claude Code's launch line", () => {
		expect(skillResultText.launching("workflow-authoring")).toBe("Launching skill: workflow-authoring");
	});
});
