import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpenRouter, openRouterProviderName, toolCallCorruptionNotice } from "../../extensions/lib/openrouter-generation.ts";

const response = (provider: unknown = "Morph") => ({ ok: true, status: 200, json: async () => ({ data: { provider_name: provider } }) });

describe("OpenRouter generation attribution", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let controller: AbortController;
	beforeEach(() => {
		vi.useFakeTimers();
		controller = new AbortController();
		fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(async () => {
		controller.abort();
		await vi.runAllTimersAsync();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	const lookup = (getApiKey = async () => "key") => openRouterProviderName("gen-123", getApiKey, controller.signal);

	it("encodes the generation id and uses the session credential only for OpenRouter", async () => {
		expect(await openRouterProviderName("gen &/?", async () => "key", controller.signal)).toBe("Morph");
		expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/generation?id=gen%20%26%2F%3F", expect.objectContaining({ headers: { Authorization: "Bearer key" } }));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retries lagging generation metadata", async () => {
		// An omitted provider name is a successful response that is not ready yet.
		fetchMock.mockResolvedValueOnce({ ok: false, status: 404 })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) })
			.mockResolvedValue(response());
		const result = lookup();
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toBe("Morph");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retries network and malformed-response failures within the same deadline", async () => {
		fetchMock.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("bad JSON"); } })
			.mockResolvedValueOnce(response(42))
			.mockResolvedValueOnce(response("  "))
			.mockResolvedValueOnce(response(" Morph "));
		const result = lookup();
		await vi.advanceTimersByTimeAsync(4000);
		expect(await result).toBe("Morph");
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it.each([401, 403])("does not retry authentication failure %s", async (status) => {
		const cancel = vi.fn(async () => {});
		fetchMock.mockResolvedValue({ ok: false, status, body: { cancel } });
		expect(await lookup()).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns unknown without exposing credential-resolution errors", async () => {
		expect(await lookup(async () => { throw new Error("secret-key"); })).toBeUndefined();
		expect(await openRouterProviderName("gen-123", async () => undefined, controller.signal)).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does no work without a generation id or after cancellation", async () => {
		const getApiKey = vi.fn(async () => "key");
		expect(await openRouterProviderName(undefined, getApiKey, controller.signal)).toBeUndefined();
		controller.abort();
		expect(await lookup(getApiKey)).toBeUndefined();
		expect(getApiKey).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["auth", "fetch", "body"])("bounds a stalled %s operation to eight seconds", async (stage) => {
		let settled = false;
		const stalled = () => new Promise<never>(() => {});
		if (stage === "fetch") fetchMock.mockImplementation(stalled);
		if (stage === "body") fetchMock.mockResolvedValue({ ok: true, json: stalled });
		const result = lookup(stage === "auth" ? stalled : undefined).then((value) => { settled = true; return value; });
		await vi.advanceTimersByTimeAsync(7999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		if (stage !== "auth") expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
	});

	it("bounds repeated not-ready responses and releases the retry timer", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 });
		const result = lookup();
		await vi.advanceTimersByTimeAsync(8000);
		expect(await result).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(8);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels a retry immediately rather than waiting for the deadline", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 });
		const result = lookup();
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		expect(await result).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not start a request if auth resolves after cancellation", async () => {
		let resolveKey!: (value: string) => void;
		const result = lookup(() => new Promise((resolve) => { resolveKey = resolve; }));
		controller.abort();
		expect(await result).toBeUndefined();
		resolveKey("late-key");
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("OpenRouter recognition and user notice", () => {
	it.each([
		{ provider: "openrouter" },
		{ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" },
		{ provider: "custom", baseUrl: "https://api.openrouter.ai/api/v1" },
	])("recognizes %j", (model) => expect(isOpenRouter(model)).toBe(true));

	it.each([
		undefined,
		{ provider: "openai" },
		{ provider: "custom", baseUrl: "invalid" },
		{ provider: "custom", baseUrl: "https://example.com/openrouter.ai" },
		{ provider: "custom", baseUrl: "https://openrouter.ai.example.com" },
		{ provider: "custom", baseUrl: "https://notopenrouter.ai" },
	])("does not activate for %j", (model) => expect(isOpenRouter(model)).toBe(false));

	it("includes a model-scoped routing fix and a model-switch alternative", () => {
		const notice = toolCallCorruptionNotice("z-ai/glm-5.3", "Morph");
		expect(notice).toContain("Morph is corrupting tool calls for z-ai/glm-5.3");
		expect(notice).toContain('compat.openRouterRouting.ignore');
		expect(notice).toContain('"ignore": ["Morph"]');
		expect(notice).toContain("models.json");
		expect(notice).toContain("switch models");
	});

	it("does not guess the provider name when attribution fails", () => {
		const notice = toolCallCorruptionNotice("z-ai/glm-5.3", undefined);
		expect(notice).toContain("could not be identified");
		expect(notice).toContain('"ignore": ["PROVIDER_NAME"]');
		expect(notice).not.toContain("Morph");
	});
});
