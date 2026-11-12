/**
 * One Code's subagent wording (profile/text/subagents/): the nested Agent
 * tool's description. The base's results are checked in
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
});
