import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	firstUserText,
	isNameableText,
	parseTitle,
	SESSION_TEXT_LIMIT,
	SESSION_TITLE_LANGUAGE_NOTE,
	SESSION_TITLE_PROMPT,
	sessionTitleInput,
} from "../../extensions/session-title/title.ts";

describe("session title prompt (CC 2.1.278 capture)", () => {
	it("matches the captured naming request verbatim when the capture is present", () => {
		let capture: { system: Array<{ text: string }>; messages: Array<{ content: Array<{ text: string }> }> } | undefined;
		try {
			capture = JSON.parse(readFileSync(new URL("../../captures/session_name.json", import.meta.url), "utf8"));
		} catch {
			return; // the capture is an internal file; the literal below is the locked copy
		}
		expect(SESSION_TITLE_PROMPT).toBe(capture!.system[2].text);
		expect(sessionTitleInput("what do you think of one code. pincer-agent project in ~/ml/")).toBe(capture!.messages[0].content[0].text);
	});

	it("frames the text in <session> tags followed by the language note", () => {
		expect(sessionTitleInput("  fix the footer  ")).toBe(`<session>\nfix the footer\n</session>\n\n${SESSION_TITLE_LANGUAGE_NOTE}`);
	});

	it("keeps the TAIL of an over-long first message (CC's MAX_CONVERSATION_TEXT)", () => {
		const text = "x".repeat(SESSION_TEXT_LIMIT) + "END";
		const input = sessionTitleInput(text);
		expect(input).toContain("END\n</session>");
		expect(input).not.toContain("x".repeat(SESSION_TEXT_LIMIT));
	});
});

describe("isNameableText", () => {
	it("waits for real prose: no breadcrumbs, bash-mode input, slash commands or blanks", () => {
		expect(isNameableText("Fix the login button")).toBe(true);
		expect(isNameableText("   ")).toBe(false);
		expect(isNameableText("/clear")).toBe(false);
		expect(isNameableText("<command-name>/model</command-name>")).toBe(false);
		expect(isNameableText("<local-command-stdout></local-command-stdout>")).toBe(false);
		expect(isNameableText("<bash-input>ls</bash-input>")).toBe(false);
	});
});

describe("parseTitle", () => {
	it("reads CC's JSON shape, also inside a fence or after prose", () => {
		expect(parseTitle('{"title": "One Code project impressions"}')).toBe("One Code project impressions");
		expect(parseTitle('```json\n{"title":"footer branch label"}\n```')).toBe("Footer branch label");
		expect(parseTitle('Sure. {"title": "LSP diagnostics delta"}')).toBe("LSP diagnostics delta");
	});

	it("accepts a single bare line when no JSON was attempted, and refuses paragraphs", () => {
		expect(parseTitle('"Vultr Linux VM bootstrap"')).toBe("Vultr Linux VM bootstrap");
		expect(parseTitle("line one\nline two")).toBeUndefined();
		expect(parseTitle("a".repeat(200))).toBeUndefined();
		expect(parseTitle("")).toBeUndefined();
	});

	it("gives up on malformed JSON rather than titling the session with it", () => {
		expect(parseTitle('{"title": ')).toBeUndefined();
		expect(parseTitle('{"name": "x"}')).toBeUndefined();
	});
});

describe("firstUserText", () => {
	it("returns the first user message's text, string or block content", () => {
		expect(firstUserText([{ type: "message", message: { role: "assistant", content: "hi" } }, { type: "message", message: { role: "user", content: "first" } }, { type: "message", message: { role: "user", content: "second" } }])).toBe("first");
		// customMessageText renders a non-text block as an empty segment; the callers trim.
		expect(
			firstUserText([{ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "with image" }] } }])?.trim(),
		).toBe("with image");
		expect(firstUserText([{ type: "session_info" }])).toBeUndefined();
	});
});
