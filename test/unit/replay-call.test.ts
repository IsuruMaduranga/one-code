import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: (...args: unknown[]) => completeSimple(...args) }));

const { replaySideCall } = await import("../../extensions/lib/replay-call.ts");
const { captureRequest, LastExchange } = await import("../../extensions/lib/request-replay.ts");

const model = { api: "anthropic-messages", provider: "my-proxy", id: "claude-sonnet-5", baseUrl: "https://proxy.example" } as never;
const ctx = {
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }) },
	sessionManager: { getSessionId: () => "s1" },
} as never;

function exchange() {
	const e = new LastExchange();
	e.setCapture(captureRequest(model, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], max_tokens: 32000 }));
	return e as never;
}

const reply = (stopReason: string, text = "") => ({ role: "assistant", stopReason, content: text ? [{ type: "text", text }] : [], usage: {} });

describe("replaySideCall", () => {
	beforeEach(() => completeSimple.mockReset());

	it("returns the answer text, and splices the tail onto the captured body", async () => {
		completeSimple.mockResolvedValue(reply("stop", "the answer"));
		const answer = await replaySideCall(ctx, model, exchange(), "q?", { signal: new AbortController().signal, timeoutMs: 1000, onUsage: () => {} });
		expect(answer).toBe("the answer");
		const onPayload = completeSimple.mock.calls[0][2].onPayload as (p: unknown) => { messages: unknown[] };
		const out = onPayload({ messages: [{ role: "user", content: [{ type: "text", text: "q?" }] }] });
		expect(out.messages).toHaveLength(1);
	});

	it("returns empty when the caller aborted, and falls back (undefined) on an error", async () => {
		const aborted = new AbortController();
		aborted.abort();
		completeSimple.mockResolvedValue(reply("aborted"));
		expect(await replaySideCall(ctx, model, exchange(), "q", { signal: aborted.signal, timeoutMs: 1000, onUsage: () => {} })).toBe("");
		completeSimple.mockResolvedValue(reply("error"));
		expect(await replaySideCall(ctx, model, exchange(), "q", { signal: new AbortController().signal, timeoutMs: 1000, onUsage: () => {} })).toBeUndefined();
	});

	it("throws on its own timeout, so the caller does not start a second call", async () => {
		completeSimple.mockImplementationOnce(async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
			await new Promise((resolve) => options.signal.addEventListener("abort", resolve));
			return reply("aborted");
		});
		await expect(replaySideCall(ctx, model, exchange(), "q", { signal: new AbortController().signal, timeoutMs: 5, onUsage: () => {} })).rejects.toThrow("No answer within");
	});

	it("falls back (undefined) when the reply holds no text, such as a tool call", async () => {
		completeSimple.mockResolvedValue({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], usage: {} });
		expect(await replaySideCall(ctx, model, exchange(), "q", { signal: new AbortController().signal, timeoutMs: 1000, onUsage: () => {} })).toBeUndefined();
	});

	it("does not call the model without a capture for it", async () => {
		const other = { ...(model as object), id: "claude-opus-5-5" } as never;
		expect(await replaySideCall(ctx, other, exchange(), "q", { signal: new AbortController().signal, timeoutMs: 1000, onUsage: () => {} })).toBeUndefined();
		expect(completeSimple).not.toHaveBeenCalled();
	});
});
