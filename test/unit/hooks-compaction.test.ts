import { completeSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../extensions/compaction/index.ts";
import hooksExtension from "../../extensions/hooks/index.ts";
import { runHookCommand } from "../../extensions/hooks/executor.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
vi.mock("../../extensions/hooks/executor.ts", () => ({ runHookCommand: vi.fn() }));
vi.mock("../../extensions/hooks/settings.ts", () => ({
	loadHookSettings: () => ({
		diagnostics: [],
		sources: [{ scope: "user", config: { PreCompact: [{ hooks: [{ type: "command", command: "preserve-context" }] }] } }],
	}),
}));
vi.mock("../../extensions/hooks/plugin-hooks.ts", () => ({ loadPluginHooks: () => [] }));

const complete = vi.mocked(completeSimple);
const hook = vi.mocked(runHookCommand);
const model = { api: "openai-completions", provider: "openrouter", id: "test-model", contextWindow: 200_000, maxTokens: 16_384 };
const user = { role: "user", content: "Fix the database migration.", timestamp: 1 };
const reply = {
	role: "assistant", content: [{ type: "text", text: "I found a rollback failure." }], stopReason: "stop", timestamp: 2,
	api: model.api, provider: model.provider, model: model.id,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

beforeEach(() => {
	vi.stubEnv("CC_COMPACTION", undefined);
	complete.mockReset();
	complete.mockResolvedValue({ ...reply, content: [{ type: "text", text: "<summary>Preserved context.</summary>" }] } as never);
	hook.mockReset();
	hook.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "Preserve rollback steps verbatim.", stderr: "", durationMs: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("PreCompact hook instructions reach the summarizer", () => {
	it.each([
		["manual", undefined, false],
		["manual", "Focus on migration.", false],
		["manual", "Focus on migration.", true],
		["threshold", undefined, true],
		["overflow", undefined, false],
	] as const)("preserves hook output for %s with instructions %s and replay %s", async (reason, customInstructions, replay) => {
		const fake = createFakePi();
		hooksExtension(fake.pi as never);
		compactionExtension(fake.pi as never);
		const ctx = createFakeCtx({
			model,
			thinkingLevel: "off",
			getSystemPrompt: () => "Session system prompt",
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
		});
		if (replay) await fake.fire("context", { messages: [user, reply] }, ctx);
		const event = {
			reason, customInstructions, signal: new AbortController().signal,
			branchEntries: [{ type: "message", id: "user", message: user }, { type: "message", id: "reply", message: reply }],
			preparation: { messagesToSummarize: [user], turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: "reply", tokensBefore: 100 },
		};
		await fake.fire("session_before_compact", event, ctx);
		expect(complete).toHaveBeenCalledTimes(1);
		const request = JSON.stringify(complete.mock.calls[0][1]);
		expect(request.split("Preserve rollback steps verbatim.")).toHaveLength(2);
		if (customInstructions) expect(request).toContain(customInstructions);

		// An unrelated later compaction must not inherit successful earlier hooks.
		hook.mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 1 });
		await fake.fire("session_before_compact", { ...event, customInstructions: undefined, signal: new AbortController().signal }, ctx);
		expect(JSON.stringify(complete.mock.calls[1][1])).not.toContain("Preserve rollback steps verbatim.");
	});
});
