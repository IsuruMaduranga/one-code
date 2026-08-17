import { describe, expect, it } from "vitest";
import { SEARCH_TOOLS, withSearchTools } from "../../extensions/search-tools/tools.ts";

const BASE = ["read", "bash", "edit", "write"];

describe("withSearchTools", () => {
	it("adds grep/find/ls for the tiny tier only", () => {
		expect(withSearchTools(BASE, "tiny")).toEqual([...BASE, "grep", "find", "ls"]);
	});

	it("keeps the surface lean for cheap/workhorse/frontier (matches CC — bash covers search)", () => {
		for (const tier of ["cheap", "workhorse", "frontier"] as const) {
			expect(withSearchTools(BASE, tier)).toEqual(BASE);
		}
	});

	it("does not duplicate already-active search tools", () => {
		const active = [...BASE, "grep"];
		expect(withSearchTools(active, "tiny")).toEqual([...BASE, "grep", "find", "ls"]);
	});

	it("removes search tools when the tier moves off tiny", () => {
		const active = [...BASE, ...SEARCH_TOOLS, "subagent"];
		expect(withSearchTools(active, "cheap")).toEqual([...BASE, "subagent"]);
	});

	it("preserves the order of unrelated names (prompt byte-stability)", () => {
		const active = ["subagent", ...BASE];
		expect(withSearchTools(active, "tiny").slice(0, 5)).toEqual(["subagent", ...BASE]);
	});
});
