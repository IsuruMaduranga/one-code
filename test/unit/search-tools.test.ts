import { describe, expect, it } from "vitest";
import { SEARCH_TOOLS, withSearchTools } from "../../extensions/search-tools/tools.ts";

const BASE = ["read", "bash", "edit", "write"];

describe("withSearchTools", () => {
	it("adds grep/find/ls for the low tier", () => {
		expect(withSearchTools(BASE, "low")).toEqual([...BASE, "grep", "find", "ls"]);
	});

	it("adds grep/find/ls for the mid tier", () => {
		expect(withSearchTools(BASE, "mid")).toEqual([...BASE, "grep", "find", "ls"]);
	});

	it("keeps the frontier surface lean", () => {
		expect(withSearchTools(BASE, "frontier")).toEqual(BASE);
	});

	it("does not duplicate already-active search tools", () => {
		const active = [...BASE, "grep"];
		expect(withSearchTools(active, "low")).toEqual([...BASE, "grep", "find", "ls"]);
	});

	it("removes search tools when the tier moves to frontier", () => {
		const active = [...BASE, ...SEARCH_TOOLS, "subagent"];
		expect(withSearchTools(active, "frontier")).toEqual([...BASE, "subagent"]);
	});

	it("preserves the order of unrelated names (prompt byte-stability)", () => {
		const active = ["subagent", ...BASE];
		expect(withSearchTools(active, "mid").slice(0, 5)).toEqual(["subagent", ...BASE]);
	});
});
