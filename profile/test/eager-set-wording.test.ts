/**
 * One Code's two forms of the Agent tool's description: the short form opens
 * with the short description, the long form with the long one. The base's
 * switch between them on a cheap model: test/unit/eager-set.test.ts.
 */
import { describe, expect, it } from "vitest";
import { AGENT_LONG_DESCRIPTION, AGENT_SHORT_DESCRIPTION, agentDescription } from "../text/subagents/agent-description.ts";

describe("One Code's Agent tool description forms", () => {
	it("the short form opens with the short description, the long form with the long one", () => {
		expect(agentDescription("short").startsWith(AGENT_SHORT_DESCRIPTION)).toBe(true);
		expect(agentDescription("long").startsWith(AGENT_LONG_DESCRIPTION.trimEnd())).toBe(true);
	});
});
