/**
 * One Code's agent catalog row for an agent that lists no tools: Claude Code
 * writes "(Tools: *)" for its built-in agents and "(Tools: All tools)" for an
 * agent file.
 */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("agent catalog tools clause", () => {
	it("says All tools for an agent file, * for a bundled agent", () => {
		const { catalogRow } = requireText("subagents");
		expect(catalogRow({ name: "mine", description: "My agent", tools: { kind: "all", builtIn: false } })).toBe("- mine: My agent (Tools: All tools)");
		expect(catalogRow({ name: "general-purpose", description: "Does it", tools: { kind: "all", builtIn: true } })).toBe("- general-purpose: Does it (Tools: *)");
	});
});
