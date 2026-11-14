import { describe, expect, it } from "vitest";
import { SEARCH_TOOLS, searchToolsEnabled } from "../../extensions/lib/models/model-tier.ts";
import { tierLabel } from "../../extensions/commands/doctor/models.ts";
import { withSearchTools } from "../../extensions/tools/search-tools/tools.ts";

const BASE = ["read", "bash", "edit", "write"];

describe("searchToolsEnabled", () => {
	it("is true on the tiny tier with all three tools live, and on no other tier", () => {
		expect(searchToolsEnabled("tiny", () => true)).toBe(true);
		for (const tier of ["cheap", "workhorse", "frontier"] as const) expect(searchToolsEnabled(tier, () => true)).toBe(false);
	});

	it("treats the three as one unit: any of them off leaves search to the shell", () => {
		for (const off of SEARCH_TOOLS) expect(searchToolsEnabled("tiny", (tool) => tool !== off), off).toBe(false);
	});
});

describe("/doctor's tier label", () => {
	it("names the search tools only for a tiny session that has them", () => {
		expect(tierLabel("tiny", () => true)).toMatch(/and grep\/find\/ls$/);
		expect(tierLabel("tiny", (tool) => tool !== "ls")).not.toContain("grep/find/ls");
		expect(tierLabel("cheap", () => true)).not.toContain("grep/find/ls");
	});
});

describe("withSearchTools", () => {
	it("adds grep/find/ls when the session has the search tools", () => {
		expect(withSearchTools(BASE, true)).toEqual([...BASE, "grep", "find", "ls"]);
	});

	it("keeps the surface lean otherwise", () => {
		expect(withSearchTools(BASE, false)).toEqual(BASE);
	});

	it("does not duplicate already-active search tools", () => {
		expect(withSearchTools([...BASE, "grep"], true)).toEqual([...BASE, "grep", "find", "ls"]);
	});

	it("removes all three when the session stops having them, a partly active set included", () => {
		expect(withSearchTools([...BASE, ...SEARCH_TOOLS, "subagent"], false)).toEqual([...BASE, "subagent"]);
		expect(withSearchTools([...BASE, "grep", "find"], false)).toEqual(BASE);
	});

	it("preserves the order of unrelated names (prompt byte-stability)", () => {
		expect(withSearchTools(["subagent", ...BASE], true).slice(0, 5)).toEqual(["subagent", ...BASE]);
	});
});
