import { describe, expect, it } from "vitest";
import { addUsage, emptyUsage, formatTokenCount, formatUsage } from "../../extensions/subagents/usage.ts";

describe("addUsage", () => {
	it("sums usage across assistant messages", () => {
		const totals = emptyUsage();
		addUsage(totals, {
			input: 1000,
			output: 200,
			cacheRead: 500,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		});
		addUsage(totals, { input: 400, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 500, cost: { total: 0.01 } });
		expect(totals).toEqual({ input: 1400, output: 300, cacheRead: 500, cacheWrite: 100, total: 2300, cost: 0.04 });
	});

	it("ignores missing or malformed usage from the JSONL stream", () => {
		const totals = emptyUsage();
		addUsage(totals, undefined);
		addUsage(totals, "not an object");
		addUsage(totals, { input: "12", output: NaN, totalTokens: null, cost: {} });
		expect(totals).toEqual(emptyUsage());
	});
});

describe("formatTokenCount", () => {
	it("shows small counts raw and large counts in k", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(45_300)).toBe("45.3k");
		expect(formatTokenCount(238_000)).toBe("238k");
	});
});

describe("formatUsage", () => {
	it("renders tokens and cost, omitting a zero cost", () => {
		const totals = { ...emptyUsage(), total: 2300, cost: 0.0421 };
		expect(formatUsage(totals)).toBe("2.3k tokens · $0.0421");
		expect(formatUsage({ ...emptyUsage(), total: 500 })).toBe("500 tokens");
	});

	it("is empty when nothing was recorded", () => {
		expect(formatUsage(emptyUsage())).toBe("");
	});
});
