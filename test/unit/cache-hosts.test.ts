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

	it("reports a failed lookup instead of a host", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "test-key");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
		expect((await lookupHosts(["gen-a"])).get("gen-a")).toEqual({ error: "generation lookup returned 500" });
	});
});
