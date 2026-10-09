import { describe, expect, it } from "vitest";
import { fetchWithTimeout } from "../../extensions/lib/fetch-timeout.ts";

/** Headers at once, then a body that never arrives and ignores the abort signal. */
const stalledBody = (async () =>
	new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("fetchWithTimeout", () => {
	it("keeps the deadline through the body, not just the headers", async () => {
		const started = Date.now();
		await expect(fetchWithTimeout("https://example.test/a.json", 50, (response) => response.json(), { fetchImpl: stalledBody })).rejects.toThrow(
			"example.test did not answer within 50 ms",
		);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("aborts early on the caller's signal, and passes the signal to fetch", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
			seen = init?.signal ?? undefined;
			return stalledBody("");
		}) as typeof fetch;
		const pending = fetchWithTimeout("https://example.test/a.json", 60_000, (response) => response.json(), { fetchImpl: impl, signal: controller.signal });
		controller.abort(new Error("session ended"));
		await expect(pending).rejects.toThrow("session ended");
		expect(seen?.aborted).toBe(true);
	});

	it("returns what the reader returns", async () => {
		const impl = (async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch;
		expect(await fetchWithTimeout("https://example.test/a.json", 1000, (response) => response.json(), { fetchImpl: impl })).toEqual({ ok: 1 });
	});
});
