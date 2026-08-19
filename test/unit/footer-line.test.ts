import { describe, expect, it } from "vitest";
import {
	buildFooterLines,
	computeMainUsage,
	formatCost,
	formatTokens,
	type FooterData,
	type Paint,
} from "../../extensions/footer/footer-line.ts";

/** Identity paint so assertions see the plain line. */
const plain: Paint = (_color, text) => text;

const base: FooterData = {
	cwd: "/home/me/proj",
	home: "/home/me",
	branch: "master",
	contextTokens: 120_000,
	contextWindow: 1_000_000,
	contextPercent: 12,
	cost: 0.78,
	cacheHitPercent: 94,
	pr: 123,
	model: "opus-4.8",
	effort: "high",
};

describe("formatTokens / formatCost", () => {
	it("matches pi's k/M thresholds", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(5000)).toBe("5.0k");
		expect(formatTokens(120_000)).toBe("120k");
		expect(formatTokens(1_100_000)).toBe("1.1M");
	});
	it("uses 3 decimals until $100", () => {
		expect(formatCost(0.745)).toBe("$0.745");
		expect(formatCost(123.4)).toBe("$123.40");
	});
});

describe("buildFooterLines", () => {
	it("renders path, branch with its PR, and every labelled metric on one line at full width", () => {
		const [line] = buildFooterLines(base, 120, plain);
		// The open PR is attached to the branch on the left, not a separate metric.
		expect(line).toContain("~/proj ⎇ master ← PR #123");
		expect(line).toContain("usage: 120k/1.0M (12%)");
		expect(line).toContain("cost: $0.780");
		expect(line).toContain("cache-hit: 94%");
		expect(line).toContain("opus-4.8");
		expect(line).toContain("high");
		expect(line.length).toBeLessThanOrEqual(120);
	});

	it("keeps the branch but drops its PR when the two together will not fit", () => {
		// A width where "⎇ master" fits after the metrics but "⎇ master ← PR #123"
		// does not: the PR is dropped, the branch survives.
		const data: FooterData = { ...base, cacheHitPercent: undefined, contextTokens: undefined };
		const [line] = buildFooterLines(data, 46, plain);
		expect(line.length).toBeLessThanOrEqual(46);
		expect(line).toContain("⎇ master");
		expect(line).not.toContain("PR #123");
		expect(line).toContain("cost: $0.780");
	});

	it("paints the branch in accent and the PR in the link colour, path dim", () => {
		// A tagging paint records which token each non-empty segment was painted with.
		const tag: Paint = (color, text) => (text === "" ? "" : `⟪${color}:${text}⟫`);
		const [line] = buildFooterLines(base, 120, tag);
		expect(line).toContain("⟪accent: ⎇ master⟫");
		expect(line).toContain("⟪mdLink: ← PR #123⟫");
		expect(line).toContain("⟪dim:~/proj⟫");
	});

	it("folds the home directory to ~", () => {
		const [line] = buildFooterLines(base, 100, plain);
		expect(line).toContain("~/proj");
		expect(line).not.toContain("/home/me/proj");
	});

	it("shows ✦ ultracode in the effort slot when set", () => {
		const [line] = buildFooterLines({ ...base, effort: "✦ ultracode" }, 100, plain);
		expect(line).toContain("✦ ultracode");
	});

	it("drops the cache-hit and the whole left chunk when very narrow, keeping the core", () => {
		const narrow = buildFooterLines(base, 50, plain)[0];
		expect(narrow.length).toBeLessThanOrEqual(50);
		expect(narrow).not.toContain("master"); // path/branch/PR left chunk dropped
		expect(narrow).not.toContain("PR #123");
		// Core survives.
		expect(narrow).toContain("cost: $0.780");
		expect(narrow).toContain("opus-4.8");
	});

	it("head-truncates a long path with a leading … but keeps the branch and metrics", () => {
		const data: FooterData = {
			...base,
			cwd: "/very/long/path/to/some/deeply/nested/project",
			home: "",
		};
		const [line] = buildFooterLines(data, 105, plain);
		expect(line.length).toBeLessThanOrEqual(105);
		expect(line).toContain("…"); // path was shortened, not dropped
		expect(line).toContain("project"); // the deepest folder survives
		expect(line).toContain("⎇ master"); // branch kept
		expect(line).not.toContain("/very/long/path"); // the head is gone
		expect(line).toContain("opus-4.8"); // metrics intact
	});

	it("shows the fill without a percentage when it is unknown (post-compaction)", () => {
		const [line] = buildFooterLines({ ...base, contextPercent: null }, 120, plain);
		expect(line).toContain("usage: 120k/1.0M");
		expect(line).not.toContain("(12%)");
		expect(line).not.toMatch(/\(\d+%\)/);
	});

	it("always shows cost but omits PR and cache-hit when absent", () => {
		const [line] = buildFooterLines({ cwd: "/home/me/proj", home: "/home/me", cost: 0 }, 100, plain);
		expect(line).toContain("cost: $0.000");
		expect(line).not.toContain("PR #");
		expect(line).not.toContain("cache-hit:");
	});
});

describe("computeMainUsage", () => {
	it("sums assistant, tool-result, and summary cost and takes the latest cache-hit", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } },
			{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.02 } } } },
			{ type: "compaction", usage: { cost: { total: 0.05 } } },
			// Latest assistant turn: 900 of 1000 prompt tokens from cache → 90%.
			{ type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 900, cacheWrite: 0, cost: { total: 0.2 } } } },
		];
		const { cost, cacheHitPercent } = computeMainUsage(entries);
		expect(cost).toBeCloseTo(0.37, 5);
		expect(cacheHitPercent).toBeCloseTo(90, 5);
	});

	it("returns zero cost and no cache-hit for an empty session", () => {
		expect(computeMainUsage([])).toEqual({ cost: 0, cacheHitPercent: undefined });
	});

	it("leaves cache-hit unset when the provider reports no cache activity", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } },
		];
		const { cost, cacheHitPercent } = computeMainUsage(entries);
		expect(cost).toBeCloseTo(0.1, 5);
		expect(cacheHitPercent).toBeUndefined();
	});
});
