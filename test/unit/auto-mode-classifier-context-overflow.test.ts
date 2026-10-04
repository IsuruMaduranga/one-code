import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { classify, createClassifierState } from "../../extensions/auto-mode/classifier.ts";
import { loadAutoModeConfig } from "../../extensions/auto-mode/config.ts";
import { buildPayload, type ClassifyRequest } from "../../extensions/auto-mode/prompt.ts";

const completeMock = vi.mocked(completeSimple);
const config = loadAutoModeConfig("/nonexistent-home-for-tests");
const main = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra", contextWindow: 1_000_000, cost: { input: 10, output: 30 } } as any;
const screener = { provider: "openai-codex", id: "gpt-5.6-terra", name: "Terra", contextWindow: 272_000, cost: { input: 2, output: 8 } } as any;
const reply = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }], usage: {} }) as any;
const errorReply = (errorMessage: string) => ({ stopReason: "error", errorMessage, content: [] }) as any;
const text = (context: any) => context.messages[0].content as string;
const base: ClassifyRequest = {
	toolName: "bash",
	username: "tester",
	environment: config.environment,
	userMessages: ["Investigate the RPC behavior."],
	transcript: [
		{ kind: "user", text: "Investigate the RPC behavior." },
		{ kind: "tool", tool: "bash", input: { command: "cp seed probe" } },
		{ kind: "tool", tool: "bash", input: { command: "rm .rpc-probe.*" } },
	],
};

function deps() {
	return {
		registry: { getAvailable: () => [main, screener], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) } as any,
		sessionModel: main,
		config,
		state: createClassifierState(),
	};
}

beforeEach(() => {
	completeMock.mockReset();
});

describe("classifier provider context overflow", () => {
	it.each([
		"prompt is too long: 280000 tokens > 272000 maximum",
		"This model's maximum context length is 272000 tokens. Your messages resulted in 280000 tokens.",
		'{"error":{"code":"context_length_exceeded","message":"input is too large"}}',
		"Your input exceeds the context window of this model",
		"Input is too long for requested model",
		"The input token count (280000) exceeds the maximum number of tokens allowed (272000)",
	])("returns a distinct no-verdict result without retrying for %s", async (error) => {
		completeMock.mockResolvedValue(errorReply(error));
		const state = deps();
		const verdict = await classify(base, state);
		expect(verdict).toMatchObject({ decision: "block", noVerdict: true, transcriptTooLong: true });
		expect(verdict.reason).toContain("Classifier transcript exceeded context window");
		expect(verdict.reason).toContain("Compact the session (/compact) and continue.");
		expect(verdict.reason).not.toContain("choose a classifier");
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(state.state.rejected.size).toBe(0);
	});

	it("sends an oversized request whole to the selected classifier and returns provider overflow without switching models", async () => {
		completeMock.mockResolvedValue(errorReply("prompt is too long"));
		const long: ClassifyRequest = {
			...base,
			transcript: [
				...base.transcript.slice(0, -1),
				...Array.from({ length: 40 }, (_, i) => ({ kind: "tool" as const, tool: "write", input: { path: `probe-${i}.txt`, content: "x".repeat(4000) } })),
				{ kind: "tool", tool: "bash", input: { command: `echo ${"x".repeat(90_000)}` } },
			],
		};
		const small = { ...screener, contextWindow: 42_000 };
		const smallMain = { ...main, contextWindow: 42_000 };
		const state = deps();
		state.sessionModel = smallMain;
		state.registry = { getAvailable: () => [smallMain, small], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) } as any;
		const verdict = await classify(long, state);
		expect(verdict).toMatchObject({ noVerdict: true, transcriptTooLong: true });
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(completeMock.mock.calls[0][0].id).toBe(screener.id);
		expect(state.state.rejected.size).toBe(0);
		expect(text(completeMock.mock.calls[0][1])).toContain(buildPayload(long).userPrefix);
		expect(text(completeMock.mock.calls[0][1])).not.toContain("omitted for length");
	});

	it("reports stage-2 overflow as no verdict without retrying another model", async () => {
		completeMock.mockResolvedValueOnce(reply("<severity>80</severity>"));
		completeMock.mockResolvedValueOnce(errorReply("prompt is too long"));
		const verdict = await classify(base, deps());
		expect(verdict).toMatchObject({ noVerdict: true, transcriptTooLong: true });
		expect(completeMock).toHaveBeenCalledTimes(2);
	});

	it("handles a provider throwing a context overflow, not only error replies", async () => {
		completeMock.mockRejectedValue(new Error("maximum context length exceeded"));
		expect(await classify(base, deps())).toMatchObject({ noVerdict: true, transcriptTooLong: true });
		expect(completeMock).toHaveBeenCalledTimes(1);
	});

	it("does not confuse rate limits or an output-token limit with transcript overflow", async () => {
		for (const error of ["429 tokens per minute rate limit exceeded", "Throttling error: Too many tokens, please wait", "max_tokens exceeds the maximum output token limit"]) {
			completeMock.mockResolvedValue(errorReply(error));
			expect(await classify(base, deps())).not.toHaveProperty("transcriptTooLong");
		}
	});
});
