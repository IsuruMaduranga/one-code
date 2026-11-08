/** One Code's deferred-tool reminders: Claude Code's listing sentence and the miss reminder. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("deferred tool wording", () => {
	it("names the missed tool and the exact select: query to load it", () => {
		const text = requireText("toolSearch").missReminder({ name: "web_fetch" });
		expect(text).toContain("web_fetch");
		expect(text).toContain("tool_search");
		expect(text).toContain("select:web_fetch");
	});

	it("heads the listing with Claude Code's fixed sentence", () => {
		const head = requireText("toolSearch").listingHead;
		expect(head).toMatch(/^The following deferred tools are available via tool_search\./);
		expect(head).toContain('"select:<name>[,<name>...]"');
		expect(head).not.toMatch(/cannot be called yet/);
	});
});
