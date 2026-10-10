import { completeSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../extensions/compaction/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
const complete = vi.mocked(completeSimple);
const model = { api: "openai-completions", provider: "openrouter", id: "test-model", contextWindow: 200_000, maxTokens: 16_384 };
const user = (text: string, timestamp = 1) => ({ role: "user", content: text, timestamp });
const reply = (text: string) => ({
	role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2,
	api: model.api, provider: model.provider, model: model.id,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const response = (stopReason = "stop", text = "<summary>Preserved context.</summary>") => ({ ...reply(text), stopReason });

function setup() {
	const fake = createFakePi();
	compactionExtension(fake.pi as never);
	const ctx = createFakeCtx({
		model,
		thinkingLevel: "off",
		getSystemPrompt: () => "Session system prompt",
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
	});
	const messages = [user("Current session task"), reply("Current session reply")];
	const branchEntries = messages.map((message, index) => ({ type: "message", id: `entry-${index}`, message }));
	const event = {
		reason: "manual", signal: new AbortController().signal, branchEntries,
		preparation: { messagesToSummarize: [messages[0]], turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: "entry-1", tokensBefore: 100 },
	};
	return { fake, ctx, event, messages };
}

beforeEach(() => {
	vi.stubEnv("CC_COMPACTION", undefined);
	complete.mockReset();
	complete.mockResolvedValue(response() as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("compaction summarizer failures", () => {
	it.each(["error", "aborted", "length"])("does not commit a partial summary after a %s stop", async (stopReason) => {
		const { fake, ctx, event } = setup();
		complete.mockResolvedValue(response(stopReason, "<summary>Only the first task survived") as never);
		expect(await fake.fireOne("session_before_compact", event, ctx)).toBeUndefined();
	});

	it("falls back when the summarizer throws or returns an empty summary", async () => {
		const { fake, ctx, event } = setup();
		complete.mockRejectedValueOnce(new Error("Connection closed"));
		expect(await fake.fireOne("session_before_compact", event, ctx)).toBeUndefined();
		complete.mockResolvedValueOnce(response("stop", "<analysis>Thinking</analysis><summary> </summary>") as never);
		expect(await fake.fireOne("session_before_compact", event, ctx)).toBeUndefined();
	});

	it("keeps a successful summary and manual instructions", async () => {
		const { fake, ctx, event } = setup();
		const result = await fake.fireOne<{ compaction: { summary: string } }>("session_before_compact", { ...event, customInstructions: "Keep the test failures" }, ctx);
		expect(result?.compaction.summary).toContain("Preserved context.");
		expect(JSON.stringify(complete.mock.calls[0][1])).toContain("Keep the test failures");
	});
});

describe("compaction capture lifecycle", () => {
	it("does not summarize the previous session after switching sessions without a turn", async () => {
		const { fake, ctx, event } = setup();
		await fake.fire("context", { messages: [user("PRIVATE previous session task"), reply("PRIVATE previous session answer")] }, ctx);
		await fake.fire("session_start", { reason: "switch" }, ctx);
		await fake.fireOne("session_before_compact", event, ctx);
		const request = JSON.stringify(complete.mock.calls[0][1]);
		expect(request).toContain("Current session task");
		expect(request).not.toContain("PRIVATE previous session");
	});

	it.each(["session_compact", "session_tree"])("invalidates the old request after %s", async (eventName) => {
		const { fake, ctx, event } = setup();
		await fake.fire("context", { messages: [user("Abandoned request")] }, ctx);
		await fake.fire(eventName, {}, ctx);
		await fake.fireOne("session_before_compact", event, ctx);
		expect(JSON.stringify(complete.mock.calls[0][1])).toContain("Current session task");
		expect(JSON.stringify(complete.mock.calls[0][1])).not.toContain("Abandoned request");
	});
});
