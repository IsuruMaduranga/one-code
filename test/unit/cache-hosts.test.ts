import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The standalone E2E helper is intentionally plain JavaScript.
import { allowance, DEFAULT_BLOCK, hostNote, hostsNote, lookupHosts, MEASURED_HOSTS } from "../e2e/cache-hosts.mjs";

describe("allowance", () => {
	it("keeps the default for an unknown host, a failed lookup or no lookup", () => {
		expect(allowance(undefined, 28_639)).toBe(DEFAULT_BLOCK);
		expect(allowance({ host: "Wafer" }, 28_639)).toBe(DEFAULT_BLOCK);
		expect(allowance({ error: "generation lookup returned 500" }, 28_639)).toBe(DEFAULT_BLOCK);
	});

	it("allows one 512-token block on OpenInference when the read is whole blocks after an offset", () => {
		expect(MEASURED_HOSTS.OpenInference).toEqual({ block: 512, offsets: [33, 0] });
		// The failing probe run: 28,639 + 33 = 56 x 512 and 29,663 + 33 = 58 x 512; a classifier repeat read 31,744 = 62 x 512.
		for (const read of [28_639, 29_663, 29_151, 31_744]) expect(allowance({ host: "OpenInference" }, read), String(read)).toBe(512);
	});

	it("allows one 512-token block on Morph only for whole blocks with no offset", () => {
		expect(MEASURED_HOSTS.Morph).toEqual({ block: 512, offsets: [0] });
		for (const read of [31_232, 30_720, 30_208, 31_744]) expect(allowance({ host: "Morph" }, read), String(read)).toBe(512);
		expect(allowance({ host: "Morph" }, 28_639)).toBe(DEFAULT_BLOCK);
	});

	it("allows a 256-token block plus the unread tail on Relace for whole blocks", () => {
		expect(MEASURED_HOSTS.Relace).toEqual({ block: 256, offsets: [0], tail: 262 });
		// Matrix reads: 31,744 of a 32,193-token prompt (short 449) and 7,424 of 7,734 (short 310); pinned 2,048 of 2,564 (short 516).
		for (const [prompt, read] of [[32_193, 31_744], [7_734, 7_424], [2_564, 2_048]]) {
			const allowed = allowance({ host: "Relace" }, read);
			expect(allowed, String(read)).toBe(518);
			expect(prompt - read, String(read)).toBeLessThanOrEqual(allowed);
		}
		expect(allowance({ host: "Relace" }, 7_425)).toBe(DEFAULT_BLOCK);
	});

	it("keeps the default on OpenInference for a read that is not whole blocks, or nothing", () => {
		expect(allowance({ host: "OpenInference" }, 28_640)).toBe(DEFAULT_BLOCK);
		expect(allowance({ host: "OpenInference" }, 0)).toBe(DEFAULT_BLOCK);
	});
});

describe("host notes", () => {
	it("names the host, or why it is unknown, and nothing off OpenRouter", () => {
		expect(hostNote({ host: "OpenInference" })).toBe(" [host OpenInference]");
		expect(hostNote({ error: "no OpenRouter key to look the host up" })).toBe(" [host unknown: no OpenRouter key to look the host up]");
		expect(hostNote(undefined)).toBe("");
	});

	it("lists a phase's hosts once each", () => {
		expect(hostsNote([{ host: "Wafer" }, { host: "Wafer" }])).toBe(" [host Wafer]");
		expect(hostsNote([{ host: "Wafer" }, { host: "Together" }, { error: "x" }])).toBe(" [hosts Wafer, Together; some lookups failed]");
		expect(hostsNote([{ error: "x" }])).toBe(" [host unknown]");
		expect(hostsNote([undefined])).toBe("");
	});
});

describe("lookupHosts", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("looks up only OpenRouter generation ids, once each, with the key as a bearer token", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
			expect(init.headers.authorization).toBe("Bearer test-key");
			return new Response(JSON.stringify({ data: { provider_name: url.includes("gen-a") ? "OpenInference" : "Wafer" } }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetch);
		const hosts = await lookupHosts(["gen-a", "gen-b", "gen-a", "msg_anthropic", undefined]);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(hosts.get("gen-a")).toEqual({ host: "OpenInference" });
		expect(hosts.get("gen-b")).toEqual({ host: "Wafer" });
		expect(hosts.has("msg_anthropic")).toBe(false);
	});

	it("retries a 404 until OpenRouter has recorded the generation", async () => {
		vi.useFakeTimers();
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		let calls = 0;
		vi.stubGlobal("fetch", vi.fn(async () => (++calls < 4 ? new Response("not yet", { status: 404 }) : new Response(JSON.stringify({ data: { provider_name: "Morph" } }), { status: 200 }))));
		const pending = lookupHosts(["gen-a"]);
		await vi.runAllTimersAsync();
		expect((await pending).get("gen-a")).toEqual({ host: "Morph" });
		expect(calls).toBe(4);
		vi.useRealTimers();
	});

	it("gives up on a 404 within its bounded wait and says how long it waited", async () => {
		vi.useFakeTimers();
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("never", { status: 404 })));
		const pending = lookupHosts(["gen-a", "gen-b"]);
		await vi.runAllTimersAsync();
		const hosts = await pending;
		expect(hosts.get("gen-a")).toEqual({ error: "generation lookup returned 404 after 40 s of retries" });
		// The second id shares the bounded wait: it stops once 60 s have passed in all.
		expect(hosts.get("gen-b")).toEqual({ error: "generation lookup returned 404 after 58 s of retries" });
		vi.useRealTimers();
	});

	it("counts request time against the wait, caps each request by what is left and skips the ids after the deadline", async () => {
		vi.useFakeTimers();
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		const timeouts: number[] = [];
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
			timeouts.push(ms);
			return realTimeout(ms);
		});
		// Each request takes 25 s before it answers 404.
		const fetch = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25_000));
			return new Response("not yet", { status: 404 });
		});
		vi.stubGlobal("fetch", fetch);
		const pending = lookupHosts(["gen-a", "gen-b"]);
		await vi.runAllTimersAsync();
		const hosts = await pending;
		// Requests at 0 s, 27 s and 55 s (the sleeps of 2 s and 3 s between); the third ends at 80 s, past the 60 s deadline.
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(timeouts).toEqual([10_000, 10_000, 5_000]);
		expect(hosts.get("gen-a")).toEqual({ error: "generation lookup returned 404 after 80 s of retries" });
		expect(hosts.get("gen-b")?.host).toBeUndefined();
		expect(hosts.get("gen-b")?.error).toMatch(/no time left/);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("reports a failed lookup instead of a host", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
		expect((await lookupHosts(["gen-a"])).get("gen-a")).toEqual({ error: "generation lookup returned 500" });
	});
});
