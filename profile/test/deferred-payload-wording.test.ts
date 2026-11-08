/** One Code's tool_search success sentence, and Claude Code's "Tool loaded." that replaces it beside the references. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("tool_search load wording", () => {
	it("says which tools loaded, and Claude Code's short form", () => {
		const words = requireText("toolSearch");
		expect(words.result({ added: ["web_fetch"], already: [], refused: [], missing: [], withdrawn: [] })).toBe("Loaded web_fetch. These tools are now callable.");
		expect(words.toolLoaded).toBe("Tool loaded.");
	});
});
