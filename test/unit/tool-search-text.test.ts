/**
 * The tool_search result and listing wording (lib/request/tool-search-text.ts): Claude Code's
 * sentence that heads the deferred-tool listing, the reminder for a call to a
 * tool not yet loaded, the success sentence, and Claude Code's "Tool loaded."
 * that replaces it beside the references.
 */
import { describe, expect, it } from "vitest";
import { toolSearchResultText } from "../../extensions/lib/request/tool-search-text.ts";

describe("deferred tool wording", () => {
	it("names the missed tool and the exact select: query to load it", () => {
		const text = toolSearchResultText.missReminder({ name: "web_fetch" });
		expect(text).toContain("web_fetch");
		expect(text).toContain("tool_search");
		expect(text).toContain("select:web_fetch");
	});

	it("heads the listing with Claude Code's fixed sentence", () => {
		const head = toolSearchResultText.listingHead;
		expect(head).toMatch(/^The following deferred tools are available via tool_search\./);
		expect(head).toContain('"select:<name>[,<name>...]"');
		expect(head).not.toMatch(/cannot be called yet/);
	});
});

describe("tool_search load wording", () => {
	it("says which tools loaded, and Claude Code's short form", () => {
		expect(toolSearchResultText.result({ added: ["web_fetch"], already: [], refused: [], missing: [], withdrawn: [] })).toBe("Loaded web_fetch. These tools are now callable.");
		expect(toolSearchResultText.toolLoaded).toBe("Tool loaded.");
	});
});
