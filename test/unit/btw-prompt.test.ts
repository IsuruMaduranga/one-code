/**
 * The side question's history as the btw extension threads it. The side
 * question's own wording is the profile's (One Code's:
 * profile/test/btw-prompt-wording.test.ts).
 */
import { describe, expect, it } from "vitest";
import { exchangeMessages, historyMessages } from "../../extensions/agents/btw/prompt.ts";

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
