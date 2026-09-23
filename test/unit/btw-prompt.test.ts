import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exchangeMessages, historyMessages, SIDE_QUESTION_REMINDER, sideQuestionMessage } from "../../extensions/btw/prompt.ts";

const capturePath = fileURLToPath(new URL("../../captures/btw.json", import.meta.url));

describe("btw side-question reminder", () => {
	it("matches Claude Code's captured reminder byte for byte when the capture is present", () => {
		let capture: { messages: Array<{ content: string }> } | undefined;
		try {
			capture = JSON.parse(readFileSync(capturePath, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return; // the capture is an internal file; SIDE_QUESTION_REMINDER below is the locked copy
			}
			throw error;
		}
		// The last message is the side question CC sent: the reminder, a blank
		// line, then the user's question verbatim.
		const sent: string = capture!.messages.at(-1)!.content;
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

describe("exchangeMessages / historyMessages", () => {
	const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5" };

	it("sends the bare question and the answer as a user/assistant pair, as Claude Code threads its side history", () => {
		const [user, assistant] = exchangeMessages({ question: "why?", answer: "because." }, model, 7) as [never, never];
		expect(user).toEqual({ role: "user", content: [{ type: "text", text: "why?" }], timestamp: 7 });
		expect(assistant).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "because." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-5",
			stopReason: "stop",
		});
	});

	it("lists every earlier exchange oldest first", () => {
		const messages = historyMessages(
			[
				{ question: "a", answer: "1" },
				{ question: "b", answer: "2" },
			],
			model,
		);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(messages.map((m) => (m.content as { text: string }[])[0].text)).toEqual(["a", "1", "b", "2"]);
	});
});
