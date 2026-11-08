/**
 * One Code's words for the capability blocks and refusals the capability
 * tests place: the agent catalog under Claude Code's heading, its rows, and
 * the skill tool's refusal of a user-only skill.
 */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("capability block wording", () => {
	it("heads the agent catalog as Claude Code does and words each row", () => {
		const words = requireText("subagents");
		const row = words.catalogRow({ name: "editor", description: "Edits prose", tools: { kind: "all", builtIn: false } });
		expect(row.startsWith("- editor: Edits prose")).toBe(true);
		expect(words.catalogBlock({ rows: [row] })).toMatch(/^Available agent types for the Agent tool:\n- editor: Edits prose/);
	});

	it("tells the model a user-only skill is the user's to run", () => {
		expect(requireText("skill").userOnly("beta")).toContain("only the user can run it, by typing /beta");
	});
});
