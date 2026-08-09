import { describe, expect, it } from "vitest";
import { ASSISTANT_MARKER, markAssistantMarkdown } from "../../extensions/branding/assistant-marker.ts";

describe("markAssistantMarkdown", () => {
	it("prefixes plain prose with the bullet", () => {
		expect(markAssistantMarkdown("Done. Both subjects updated.")).toBe(`${ASSISTANT_MARKER} Done. Both subjects updated.`);
	});

	it("marks only the first line, leaving the rest intact", () => {
		const out = markAssistantMarkdown("First line.\n\nSecond paragraph.");
		expect(out).toBe(`${ASSISTANT_MARKER} First line.\n\nSecond paragraph.`);
	});

	it("returns empty input unchanged", () => {
		expect(markAssistantMarkdown("")).toBe("");
	});

	// A raw prefix would demote these blocks to plain paragraphs, so they are left
	// alone rather than corrupted.
	it.each([
		["heading", "## Plan"],
		["unordered list", "- first item"],
		["star list", "* first item"],
		["ordered list", "1. first step"],
		["ordered paren", "1) first step"],
		["block quote", "> quoted"],
		["fenced code", "```ts\nconst x = 1;\n```"],
		["tilde fence", "~~~\ncode\n~~~"],
		["table row", "| a | b |"],
		["horizontal rule", "---"],
		["raw html", "<div>hi</div>"],
	])("leaves a %s first line untouched", (_label, markdown) => {
		expect(markAssistantMarkdown(markdown)).toBe(markdown);
	});

	it("still marks prose that merely contains markdown later", () => {
		const out = markAssistantMarkdown("Here is the plan:\n\n- step one\n- step two");
		expect(out).toBe(`${ASSISTANT_MARKER} Here is the plan:\n\n- step one\n- step two`);
	});

	it("does not treat an em dash or minus in prose as a list", () => {
		// "-5" and "—" are not list markers (need "- " with a space).
		expect(markAssistantMarkdown("-5 degrees today.")).toBe(`${ASSISTANT_MARKER} -5 degrees today.`);
		expect(markAssistantMarkdown("— a dash lead.")).toBe(`${ASSISTANT_MARKER} — a dash lead.`);
	});

	it("accepts a custom marker", () => {
		expect(markAssistantMarkdown("hi", "◆")).toBe("◆ hi");
	});
});
