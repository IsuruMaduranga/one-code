import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { readerMessages } from "../../extensions/web-fetch/summarize.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-5", name: "Offline reader", api: "anthropic-messages", provider: "anthropic",
	baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 4000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type Block = { type: string; text: string; cache_control?: { type: string; ttl?: string } };
type Payload = { system: Block[]; messages: { role: string; content: Block[] }[] };

async function capture(url: string, apiKey: string, cacheRetention: "short" | "long" | "none") {
	const text = readerMessages({ prompt: "What is the release?", markdown: "Release 3.2.\nExact Unicode: 😀 café.", url });
	let payload: Payload | undefined;
	const fetch = vi.fn(async () => { throw new Error("No network in this test"); });
	const result = await stream(model, normalizeContext({
		systemPrompt: text.system,
		messages: [{ role: "user", content: text.user, timestamp: 0 }],
	}), {
		apiKey, sessionId: "offline-session:reader", cacheRetention, fetch, maxRetries: 0,
		onPayload: (value) => { payload = value as Payload; throw new Error("Captured before dispatch"); },
	}).result();
	expect(result.errorMessage).toContain("Captured before dispatch");
	expect(fetch).not.toHaveBeenCalled();
	return { payload: payload!, text };
}

describe("reader through pi-ai's Anthropic adapter (offline)", () => {
	it.each(["short", "long"] as const)("marks the stable system prefix and leaves reader bytes unchanged (%s)", async (retention) => {
		const { payload, text } = await capture("https://example.com/release", "offline-key", retention);
		const cache = { type: "ephemeral", ...(retention === "long" ? { ttl: "1h" } : {}) };
		expect(payload.system).toEqual([{ type: "text", text: text.system, cache_control: cache }]);
		expect(payload.messages).toEqual([{ role: "user", content: [{ type: "text", text: text.user, cache_control: cache }] }]);
	});

	it("keeps a marked but below-minimum system prefix across different pages, without padding", async () => {
		const first = await capture("https://example.com/one", "offline-key", "short");
		const second = await capture("https://example.com/two", "offline-key", "short");
		expect(first.payload.system).toEqual(second.payload.system);
		expect(first.payload.messages).not.toEqual(second.payload.messages);
		// Even a one-token-per-byte upper bound is below Sonnet's 1024-token
		// minimum (and Haiku's 4096). A marker alone cannot make it cacheable.
		expect(Buffer.byteLength(first.text.system, "utf8")).toBeLessThan(1024);
	});

	it("keeps OAuth's system prefix markers within the four-marker limit", async () => {
		const { payload, text } = await capture("https://example.com/release", "sk-ant-oat-offline", "short");
		expect(payload.system).toHaveLength(2);
		expect(payload.system[1].text).toBe(text.system);
		expect(payload.system.every((block) => block.cache_control)).toBe(true);
		expect(payload.messages[0].content[0].text).toBe(text.user);
		const markers = [...payload.system, ...payload.messages.flatMap((message) => message.content)].filter((block) => block.cache_control);
		expect(markers).toHaveLength(3);
	});

	it("respects an explicit cache-retention opt-out", async () => {
		const { payload } = await capture("https://example.com/release", "offline-key", "none");
		expect([...payload.system, ...payload.messages[0].content].some((block) => block.cache_control)).toBe(false);
	});
});
