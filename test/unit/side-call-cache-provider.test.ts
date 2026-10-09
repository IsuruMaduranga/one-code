import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { cacheSideCallConversation } from "../../extensions/lib/side-call-cache.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-5", name: "Offline side call", api: "anthropic-messages", provider: "anthropic",
	baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 4000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type Block = { type: string; text?: string; tool_use_id?: string; cache_control?: { type: string; ttl?: string } };
type Payload = { messages: { role: string; content: string | Block[] }[] };

async function capture(messages: unknown[]): Promise<Payload> {
	let payload: Payload | undefined;
	const fetch = vi.fn(async () => { throw new Error("No network in this test"); });
	const result = await stream(model, normalizeContext({ systemPrompt: "", messages: messages as never[] }), {
		apiKey: "offline-key", sessionId: "offline-session:btw", cacheRetention: "short", fetch, maxRetries: 0,
		onPayload: (value) => {
			cacheSideCallConversation(value);
			payload = value as Payload;
			throw new Error("Captured before dispatch");
		},
	}).result();
	expect(result.errorMessage).toContain("Captured before dispatch");
	expect(fetch).not.toHaveBeenCalled();
	return payload!;
}

const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });
const assistant = (content: unknown[], timestamp: number, stopReason = "stop") => ({
	role: "assistant" as const, content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5", usage: {}, stopReason, timestamp,
});

describe("side-call cache through pi-ai's Anthropic adapter (offline)", () => {
	it("converts the latest preceding string user turn and marks it instead of the question", async () => {
		const payload = await capture([
			user("Initial user", 1),
			assistant([{ type: "text", text: "Assistant answer" }], 2),
			user("Latest user bytes 😀", 3),
			user("Side question", 4),
		]);

		expect(payload.messages).toEqual([
			{ role: "user", content: "Initial user" },
			{ role: "assistant", content: [{ type: "text", text: "Assistant answer" }] },
			{ role: "user", content: [{ type: "text", text: "Latest user bytes 😀", cache_control: { type: "ephemeral" } }] },
			{ role: "user", content: [{ type: "text", text: "Side question" }] },
		]);
	});

	it("moves the marker to an assistant text block", async () => {
		const payload = await capture([
			user("Initial user", 1),
			assistant([{ type: "text", text: "Assistant answer" }], 2),
			user("Side question", 3),
		]);

		expect(payload.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Assistant answer", cache_control: { type: "ephemeral" } }] });
		expect(payload.messages[2]).toEqual({ role: "user", content: [{ type: "text", text: "Side question" }] });
	});

	it("moves the marker to a tool-result block", async () => {
		const payload = await capture([
			user("Initial user", 1),
			assistant([{ type: "toolCall", id: "tool-1", name: "Read", arguments: {} }], 2, "toolUse"),
			{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "File bytes" }], isError: false, timestamp: 3 },
			user("Side question", 4),
		]);

		expect(payload.messages[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "tool-1", content: "File bytes", is_error: false, cache_control: { type: "ephemeral" } }],
		});
		expect(payload.messages[3]).toEqual({ role: "user", content: [{ type: "text", text: "Side question" }] });
	});
});
