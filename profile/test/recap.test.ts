/** One Code's recap wording (profile/text/recap/). The base's recap behavior is in test/unit/recap.test.ts. */
import { describe, expect, it } from "vitest";
import { RECAP_PROMPT, recap } from "../text/recap/index.ts";

describe("One Code's recap prompt", () => {
	it("uses Claude Code 2.1.261's verbatim away-summary instruction", () => {
		expect(RECAP_PROMPT).toBe(
			"The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.",
		);
		expect(recap.prompt).toBe(RECAP_PROMPT);
	});
});
