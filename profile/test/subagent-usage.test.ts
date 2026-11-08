/** One Code's wording for a subagent's usage line (profile/text/subagents/). The base's part is in test/unit/subagent-usage.test.ts. */
import { describe, expect, it } from "vitest";
import { emptyUsage, formatStats } from "../../extensions/subagents/usage.ts";

describe("One Code's subagent usage line", () => {
	it("renders tools, tokens and cost, omitting a zero cost", () => {
		const totals = { ...emptyUsage(), total: 2300, cost: 0.0421 };
		expect(formatStats(3, totals)).toBe("3 tools · 2.3k tokens · $0.0421");
		expect(formatStats(0, { ...emptyUsage(), total: 500 })).toBe("0 tools · 500 tokens");
	});

	it("names only the tools when no usage was recorded", () => {
		expect(formatStats(2, emptyUsage())).toBe("2 tools");
	});
});
