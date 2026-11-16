import type { completeSimple as CompleteSimple } from "@earendil-works/pi-ai/compat";
import { registryStream } from "./helpers/side-call-registry.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../extensions/context/compaction/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envName } from "../../extensions/lib/profile/brand.mjs";

/** Stands in for the provider behind the model registry's stream (helpers/side-call-registry.ts). */
const completeSimple = vi.fn<typeof CompleteSimple>();

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
		modelRegistry: { streamSimple: registryStream(completeSimple), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
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

describe("compaction fallback reporting", () => {
	function logged(path: string): Record<string, unknown>[] {
		return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("tells the user once per session why the cache-reading compaction gave way, and logs every fallback", async () => {
		const log = join(mkdtempSync(join(tmpdir(), "compaction-fallback-")), "side-calls.jsonl");
		vi.stubEnv(envName("SIDE_CALL_LOG"), log);
		const { fake, ctx, event } = setup();
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		const registry = ctx.modelRegistry as { getApiKeyAndHeaders: unknown };
		// pi's runtime refuses the call generically; the registry names the cause.
		registry.getApiKeyAndHeaders = async () => ({ ok: false, error: "OAuth refresh failed for openrouter" });
		complete.mockResolvedValue({ ...response("error"), errorMessage: "Provider is not configured: openrouter" } as never);
		expect(await fake.fireOne("session_before_compact", event, ctx)).toBeUndefined();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("OAuth refresh failed for openrouter");
		expect(notify.mock.calls[0][0]).toContain("/login");
		expect(notify.mock.calls[0][1]).toBe("warning");

		// A second failure in the same session is logged, not shown again.
		complete.mockResolvedValue({ ...response("error"), errorMessage: "529 Overloaded" } as never);
		expect(await fake.fireOne("session_before_compact", event, ctx)).toBeUndefined();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(logged(log)).toEqual([
			{ kind: "compaction", model: "openrouter/test-model", api: "openai-completions", sessionId: expect.any(String), failed: "credentials: OAuth refresh failed for openrouter" },
			{ kind: "compaction", model: "openrouter/test-model", api: "openai-completions", sessionId: expect.any(String), failed: "provider error: 529 Overloaded" },
		]);

		// A new session may be told again.
		await fake.fire("session_start", { reason: "new" }, ctx);
		expect(await fake.fireOne("session_before_compact", event, ctx)).toBeUndefined();
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[1][0]).toContain("529 Overloaded");
	});

	it("names a thrown error, and stays quiet about a capped or blockless summary and a cancelled compaction", async () => {
		const { fake, ctx, event } = setup();
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		complete.mockResolvedValueOnce(response("length") as never);
		await fake.fireOne("session_before_compact", event, ctx);
		complete.mockResolvedValueOnce(response("stop", "no block here") as never);
		await fake.fireOne("session_before_compact", event, ctx);
		const cancelled = new AbortController();
		cancelled.abort();
		complete.mockResolvedValueOnce(response("aborted") as never);
		await fake.fireOne("session_before_compact", { ...event, signal: cancelled.signal }, ctx);
		expect(notify).not.toHaveBeenCalled();

		complete.mockRejectedValueOnce(new Error("Connection closed"));
		await fake.fireOne("session_before_compact", event, ctx);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("Connection closed");
	});
});
