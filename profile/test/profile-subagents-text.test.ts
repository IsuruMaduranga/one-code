/**
 * One Code's subagent wording (profile/text/subagents/): the nested Agent
 * tool's description and the blocks' withdrawal sentences. The base's results are checked in
 * test/unit/subagent-text-wording.test.ts; the golden snapshot pins the Agent
 * tool and its catalog.
 */
import { describe, expect, it } from "vitest";
import { subagentsText } from "../text/subagents/index.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";

const subagents = subagentsText(ALL_LIVE);

describe("One Code's subagent text", () => {
	it("closes the nested Agent tool's catalog with its no-fork note", () => {
		expect(subagents.nestedAgentDescription({ catalog: ["- a: d"] })).toContain('Available agents:\n- a: d\n(No "fork" here');
	});

	it("withdraws each subagent block with a sentence true for that block", () => {
		expect(subagents.delegationWithdrawn).toBe("The subagent delegation guidance previously shown for this conversation is no longer active.");
		expect(subagents.catalogWithdrawn).toBe("The agent types listed earlier in this conversation can no longer be started, because the Agent tool is not available in this session.");
		expect(subagents.modelsWithdrawn).toBe("The model list shown earlier in this conversation for subagents and workflow agents no longer applies.");
	});
});
