/**
 * One Code's session-naming wording (profile/text/session-title/). The base's
 * naming behavior is in test/unit/session-title.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sessionTitleInput as titleInput } from "../../extensions/agents/session-title/title.ts";
import { SESSION_TITLE_LANGUAGE_NOTE, SESSION_TITLE_PROMPT, sessionTitle } from "../text/session-title/index.ts";

/** The naming request's user message in One Code's words. */
const sessionTitleInput = (text: string) => titleInput(sessionTitle, text);

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
});
