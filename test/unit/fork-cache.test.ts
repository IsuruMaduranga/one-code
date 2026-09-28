/**
 * subagents/fork-cache.ts: the inline extension that sends a fork's requests
 * as the parent's captured request plus the fork's tail.
 */
import { describe, expect, it } from "vitest";
import { DEFER_CHANNEL } from "../../extensions/lib/deferred.ts";
import { captureRequest, type RequestCapture } from "../../extensions/lib/request-replay.ts";
import { forkCacheExtension } from "../../extensions/subagents/fork-cache.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const model = { api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", id: "deepseek/deepseek-v4-flash" };

function setup(maxTokens: number) {
	const capture = captureRequest(
		model,
		{ messages: [{ role: "system", content: "parent" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read" } }], max_completion_tokens: maxTokens },
		{ role: "user", timestamp: 20 },
		"parent-session",
	) as RequestCapture;
	const fake = createFakePi();
	const deferred: string[] = [];
	fake.events.on(DEFER_CHANNEL, (data) => deferred.push((data as { name: string }).name));
	forkCacheExtension(capture)(fake.pi as never);
	const ctx = createFakeCtx({ model });
	const messages = [
		{ role: "system", content: "fork", timestamp: 1 },
		{ role: "user", content: "hi", timestamp: 20 },
		{ role: "user", content: "fork task", timestamp: 30 },
	];
	return { fake, ctx, messages, deferred };
}

describe("forkCacheExtension", () => {
	it("splices the fork's tail onto the parent's request", async () => {
		const { fake, ctx, messages } = setup(32000);
		const shaped = await fake.fireOne<{ messages: { timestamp: number }[] }>("context_with_system", { messages }, ctx);
		expect(shaped?.messages.map((message) => message.timestamp)).toEqual([1, 30]);
		const payload = await fake.fireOne<Record<string, unknown>>(
			"before_provider_request",
			{ payload: { messages: [{ role: "system", content: "fork" }, { role: "user", content: "fork task" }], tools: [] } },
			ctx,
		);
		expect(payload?.messages).toEqual([{ role: "system", content: "parent" }, { role: "user", content: "hi" }, { role: "user", content: "fork task" }]);
	});

	it("sends the fork whole when the tail leaves too little output room", async () => {
		const { fake, ctx, messages } = setup(1000);
		expect(await fake.fireOne("context_with_system", { messages }, ctx)).toBeUndefined();
		expect(await fake.fireOne("before_provider_request", { payload: { messages: [], tools: [] } }, ctx)).toBeUndefined();
	});

	it("sends the parent's session-affinity header so the gateway routes to the parent's host", async () => {
		const { fake, ctx } = setup(32000);
		const headers: Record<string, string> = {};
		await fake.fireOne("before_provider_headers", { headers }, ctx);
		expect(headers).toEqual({ "x-session-id": "parent-session" });
	});

	it("defers the fork's own SendMessage so tool_search can load it", () => {
		expect(setup(32000).deferred).toEqual(["SendMessage"]);
	});
});
