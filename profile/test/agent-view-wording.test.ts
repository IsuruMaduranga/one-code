/** One Code's wrapper around a message the user sends to a running agent mid-turn: Claude Code's words. */
import { describe, expect, it } from "vitest";
import { userMessageForAgent } from "../../extensions/lib/agent-view.ts";

describe("userMessageForAgent", () => {
	it("is Claude Code's mid-turn wrapper", () => {
		expect(userMessageForAgent("now give it a one-line title only")).toBe(
			"The user sent a new message while you were working:\nnow give it a one-line title only\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.",
		);
	});
});
