import { Markdown } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { commandBreadcrumb } from "../../extensions/lib/plugins/skill-invoke.ts";
import { markUserMarkdown, paintedUserMarker, USER_MARKER, userMessageMarkdown } from "../../extensions/ui/branding/user-marker.ts";

/** pi's user message Markdown, plain theme, so a test reads what a user sees. */
function rendered(markdown: string): string[] {
	const plain = new Proxy({}, { get: () => (text: string) => text });
	const md = new Markdown(markdown, 0, 0, plain as never, undefined, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true });
	return md.render(60).map((line) => line.trimEnd());
}

describe("markUserMarkdown", () => {
	it("prefixes a one-line prompt", () => {
		expect(markUserMarkdown("what files are here?")).toBe(`${USER_MARKER} what files are here?`);
	});

	it("marks only the first line of a multi-line prompt", () => {
		expect(markUserMarkdown("line one\nline two")).toBe(`${USER_MARKER} line one\nline two`);
		expect(rendered(markUserMarkdown("line one\nline two"))).toEqual([`${USER_MARKER} line one`, "line two"]);
	});

	it("puts the marker above a message that opens with a code block, leaving the block whole", () => {
		const text = "```js\nconst a = 1;\n```\nwhy?";
		expect(markUserMarkdown(text)).toBe(`${USER_MARKER}\n\n${text}`);
		const lines = rendered(markUserMarkdown(text));
		expect(lines[0]).toBe(USER_MARKER);
		expect(lines.filter((line) => line.includes("```"))).toHaveLength(2);
		expect(lines.at(-1)).toBe("why?");
	});

	it.each([
		["heading", "# Title"],
		["list", "- a\n- b"],
		["quote", "> quoted"],
		["rule", "---"],
		["table", "| a | b |\n|---|---|\n| 1 | 2 |"],
	])("keeps a leading %s a block", (_kind, text) => {
		expect(markUserMarkdown(text)).toBe(`${USER_MARKER}\n\n${text}`);
	});

	it("drops leading blank lines before marking", () => {
		expect(markUserMarkdown("\n\nhello")).toBe(`${USER_MARKER} hello`);
	});

	it("leaves empty text alone", () => {
		expect(markUserMarkdown("")).toBe("");
	});

	it("uses the painted marker it is given", () => {
		expect(markUserMarkdown("hi", "<m>")).toBe("<m> hi");
	});
});

describe("userMessageMarkdown", () => {
	it("shows a typed command by its marked command line", () => {
		const text = `${commandBreadcrumb("simplify", "focus on the parser")}Review the changed code…`;
		expect(userMessageMarkdown(text)).toBe(`${USER_MARKER} /simplify focus on the parser`);
		expect(userMessageMarkdown(`${commandBreadcrumb("init", "")}Please analyze…`)).toBe(`${USER_MARKER} /init`);
	});

	it("shows a notification that opened a turn by its headline, unmarked", () => {
		const frame = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"ls\" completed (exit code 0)</summary>\n</task-notification>";
		const out = userMessageMarkdown(frame);
		expect(out).toBe('✳ Background command "ls" completed (exit code 0)');
		expect(out).not.toContain(USER_MARKER);
	});

	it("marks any other prompt", () => {
		expect(userMessageMarkdown("!ls is a bash line")).toBe(`${USER_MARKER} !ls is a bash line`);
	});
});

describe("paintedUserMarker", () => {
	it("paints the marker dim and opens the message text colour again after it", () => {
		const theme = { fg: (color: string, text: string) => `<${color}>${text}</>`, getFgAnsi: (color: string) => `<${color}>` };
		expect(paintedUserMarker(theme)).toBe(`<dim>${USER_MARKER}</><userMessageText>`);
	});

	it("falls back to the plain marker without a theme, or when painting throws", () => {
		expect(paintedUserMarker(undefined)).toBe(USER_MARKER);
		const broken = { fg: () => { throw new Error("no theme"); }, getFgAnsi: () => "" };
		expect(paintedUserMarker(broken)).toBe(USER_MARKER);
	});
});
