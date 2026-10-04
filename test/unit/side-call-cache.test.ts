import { describe, expect, it } from "vitest";
import { cacheSideCallConversation, MAX_SIDE_CALL_CACHE_MARKERS } from "../../extensions/lib/side-call-cache.ts";

const marker = { type: "ephemeral", ttl: "1h" };

const textOf = (payload: Record<string, unknown>) =>
	((payload.messages as { content: { text?: string }[] }[])
		.flatMap((message) => message.content)
		.map((block) => block.text ?? "")
		.join(""));

const actualMarkers = (payload: { tools?: unknown; system?: unknown; messages?: unknown }) => {
	const topLevel = (value: unknown) => Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && (entry as { cache_control?: unknown }).cache_control !== undefined) : [];
	const messages = Array.isArray(payload.messages)
		? payload.messages.flatMap((message) => topLevel((message as { content?: unknown })?.content))
		: [];
	return [...topLevel(payload.tools), ...topLevel(payload.system), ...messages];
};

describe("cacheSideCallConversation", () => {
	it("moves pi-ai's question marker to the preceding assistant text without changing text", () => {
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "Earlier user." }] },
				{ role: "assistant", content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: "Earlier answer." }] },
				{ role: "user", content: [{ type: "text", text: "Question?", cache_control: marker }] },
			],
		};
		const text = textOf(payload);

		cacheSideCallConversation(payload);

		expect(textOf(payload)).toBe(text);
		expect((payload.messages[1].content[1] as { cache_control?: unknown }).cache_control).toEqual(marker);
		expect((payload.messages[2].content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
	});

	it("keeps at most four markers across tools, system, and messages", () => {
		const payload = {
			tools: [
				{
					name: "first",
					cache_control: marker,
					input: { cache_control: "tool input data" },
					input_schema: { properties: { cache_control: { type: "string", cache_control: "schema data" } } },
				},
				{ name: "second", cache_control: marker },
			],
			system: [
				{ type: "text", text: "identity", cache_control: marker },
				{ type: "text", text: "instructions", cache_control: marker },
			],
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "Earlier answer." }] },
				{ role: "user", content: [{ type: "text", text: "Question?", cache_control: marker }] },
			],
		};

		cacheSideCallConversation(payload);

		expect(actualMarkers(payload)).toHaveLength(MAX_SIDE_CALL_CACHE_MARKERS);
		expect(payload.tools[0]?.cache_control).toBeUndefined();
		expect(payload.tools[1]?.cache_control).toEqual(marker);
		const firstTool = payload.tools[0] as { input: { cache_control: string }; input_schema: { properties: { cache_control: unknown } } };
		expect(firstTool.input.cache_control).toBe("tool input data");
		expect(firstTool.input_schema.properties.cache_control).toEqual({ type: "string", cache_control: "schema data" });
		expect((payload.messages[0].content[0] as { cache_control?: unknown }).cache_control).toEqual(marker);
		expect((payload.messages[1].content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
	});

	it("converts the latest preceding string message to pi-ai's marked text-block shape", () => {
		const payload = {
			messages: [
				{ role: "user", content: "Earlier conversation" },
				{ role: "user", content: [{ type: "text", text: "Question?", cache_control: marker }] },
			],
		};

		cacheSideCallConversation(payload);

		expect(payload.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "Earlier conversation", cache_control: marker }] },
			{ role: "user", content: [{ type: "text", text: "Question?" }] },
		]);
	});

	it.each([
		undefined,
		{},
		{ messages: [] },
		{ messages: [{ role: "user", content: [{ type: "text", text: "Question?", cache_control: marker }] }] },
		{ messages: [{ role: "assistant", content: [{ type: "text", text: "Earlier" }] }, { role: "assistant", content: [{ type: "text", text: "Not a question", cache_control: marker }] }] },
	])("leaves no-conversation or unsupported wire payloads alone: %#", (payload) => {
		const before = structuredClone(payload);
		cacheSideCallConversation(payload);
		expect(payload).toEqual(before);
	});
});
