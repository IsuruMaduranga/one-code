import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SIDE_QUESTION_REMINDER, sideQuestionMessage } from "../../extensions/btw/prompt.ts";

const capturePath = fileURLToPath(new URL("../../captures/btw.json", import.meta.url));

describe("btw side-question reminder", () => {
	it("matches Claude Code's captured reminder byte for byte", () => {
		const capture = JSON.parse(readFileSync(capturePath, "utf8"));
		// The last message is the side question CC sent: the reminder, a blank
		// line, then the user's question verbatim.
		const sent: string = capture.messages.at(-1).content;
		expect(sideQuestionMessage("is this a good project")).toBe(sent);
		expect(sent.startsWith(SIDE_QUESTION_REMINDER)).toBe(true);
	});

	it("frames the answerer as a tool-less, one-off instance", () => {
		expect(SIDE_QUESTION_REMINDER).toContain("This is a side question from the user");
		expect(SIDE_QUESTION_REMINDER).toContain("You have NO tools available");
		expect(SIDE_QUESTION_REMINDER).toContain("This is a one-off response");
	});
});

describe("sideQuestionMessage", () => {
	it("trims the question but leaves the reminder intact", () => {
		const message = sideQuestionMessage("  what is this?  ");
		expect(message.endsWith("\n\nwhat is this?")).toBe(true);
		expect(message.startsWith(SIDE_QUESTION_REMINDER)).toBe(true);
	});
});
