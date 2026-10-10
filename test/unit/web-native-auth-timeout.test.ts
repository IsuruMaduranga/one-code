import { afterEach, describe, expect, it, vi } from "vitest";
import { tryNativeWeb } from "../../extensions/lib/anthropic-server-call.ts";
import { fetchOutcome, nativeFetchBody } from "../../extensions/lib/anthropic-server-tools.ts";

const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com", cost: { input: 3, output: 15 } } as any;

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("native web authentication deadline", () => {
	it.each(["timeout", "cancel"])("stops waiting on stalled authentication after %s without starting a late fetch", async (ending) => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No network in this test"); }));
		let release!: (auth: { ok: true; apiKey: string }) => void;
		const controller = new AbortController();
		const onStart = vi.fn();
		const ctx = {
			model,
			modelRegistry: {
				getAvailable: () => [model],
				getApiKeyAndHeaders: () => new Promise<{ ok: true; apiKey: string }>((resolve) => { release = resolve; }),
			},
		};
		let settled = false;
		const pending = tryNativeWeb(ctx, {
			body: (id) => nativeFetchBody({ model: id, url: "https://example.com/", prompt: "Which release?" }),
			outcome: fetchOutcome,
			onUsage: vi.fn(), onStart, signal: controller.signal,
		}).then((result) => { settled = true; return result; });
		await vi.advanceTimersByTimeAsync(0);
		if (ending === "cancel") controller.abort(new Error("session ended"));
		await vi.advanceTimersByTimeAsync(120_001);
		const settledBeforeAuth = settled;
		release({ ok: true, apiKey: "test-key" });
		const result = await pending;
		await vi.advanceTimersByTimeAsync(0);
		expect(settledBeforeAuth).toBe(true);
		expect(result.kind).toBe(ending === "cancel" ? "cancelled" : "fell-back");
		if (result.kind === "fell-back") expect(result.reason).toContain("120 seconds");
		expect(fetch).not.toHaveBeenCalled();
		expect(onStart).not.toHaveBeenCalled();
	});
});
