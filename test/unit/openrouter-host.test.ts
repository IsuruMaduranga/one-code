import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointsListingUrl, fetchEndpointQuantizations, quantizationsByHost, servedHostLabel } from "../../extensions/lib/request/openrouter-host.ts";
import { collectModelFacts, modelsSection } from "../../extensions/commands/doctor/models.ts";
import { pinCatalog } from "./catalog-fixture.ts";
import { tempHome } from "./helpers/temp-home.ts";

const listing = {
	data: {
		endpoints: [
			{ provider_name: "InferenceNet", tag: "inference-net/us", quantization: "fp8" },
			{ provider_name: "InferenceNet", tag: "inference-net/fp8", quantization: "fp8" },
			{ provider_name: "Wafer", tag: "wafer/us", quantization: "mxfp4" },
			{ provider_name: "Wafer", tag: "wafer/fp8", quantization: "fp8" },
			{ provider_name: "Cloudflare", tag: "cloudflare", quantization: null },
		],
	},
};

describe("the endpoints listing", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is read under OpenRouter's own base URL only, for the model without its alias mark", () => {
		expect(endpointsListingUrl("https://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash")).toBe("https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints");
		expect(endpointsListingUrl(undefined, "~deepseek/deepseek-flash-latest")).toBe("https://openrouter.ai/api/v1/models/deepseek/deepseek-flash-latest/endpoints");
		expect(endpointsListingUrl("https://proxy.example/api/v1", "deepseek/deepseek-v4.1-flash")).toBeUndefined();
		expect(endpointsListingUrl("not a url", "deepseek/deepseek-v4.1-flash")).toBeUndefined();
	});

	it("gives each host its precisions, in any case, with unknown for an endpoint that declares none", () => {
		const hosts = quantizationsByHost(listing);
		expect([...hosts]).toEqual([
			["inferencenet", ["fp8"]],
			["wafer", ["mxfp4", "fp8"]],
			["cloudflare", ["unknown"]],
		]);
		expect(quantizationsByHost({ error: "no" }).size).toBe(0);
	});

	it("fetches without a key and gives up quietly on a failed reply", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => listing }));
		vi.stubGlobal("fetch", fetchMock);
		const hosts = await fetchEndpointQuantizations("https://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash", new AbortController().signal);
		expect(hosts?.get("inferencenet")).toEqual(["fp8"]);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints");
		expect(init.headers).toBeUndefined();
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, body: { cancel: async () => {} } })));
		expect(await fetchEndpointQuantizations(undefined, "nobody/none", new AbortController().signal)).toBeUndefined();
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
		expect(await fetchEndpointQuantizations(undefined, "deepseek/deepseek-v4.1-flash", new AbortController().signal)).toBeUndefined();
	});

	it("labels a host with its precisions, or alone", () => {
		expect(servedHostLabel({ model: "m", host: "InferenceNet", quantizations: ["fp8"] })).toBe("InferenceNet (fp8)");
		expect(servedHostLabel({ model: "m", host: "Wafer", quantizations: ["mxfp4", "fp8"] })).toBe("Wafer (mxfp4 or fp8)");
		expect(servedHostLabel({ model: "m", host: "Cloudflare", quantizations: ["unknown"] })).toBe("Cloudflare (precision not declared)");
		expect(servedHostLabel({ model: "m", host: "Modal" })).toBe("Modal");
	});
});

describe("doctor: the OpenRouter host of the last reply", () => {
	const session = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "openai-completions", cost: { input: 0.1, output: 0.4 }, contextWindow: 1_000_000 } as any;
	const lines = (openRouterHost?: { model: string; host: string; quantizations?: string[] }) => {
		const { home } = tempHome("doctor-host-");
		pinCatalog([{ id: "deepseek/deepseek-v4.1-flash", released: "2026-09-10", price: [0.1, 0.4] }]);
		const view = { model: session, modelSource: "session" as const, openRouterHost };
		return modelsSection(collectModelFacts([session], view, home, {}), view, []).lines.filter((line) => line.text.startsWith("OpenRouter host"));
	};

	it("shows the host and its precision under the main model, dim", () => {
		expect(lines({ model: "openrouter/deepseek/deepseek-v4.1-flash", host: "InferenceNet", quantizations: ["fp8"] })).toEqual([
			{ text: "OpenRouter host of the last reply: InferenceNet (fp8)", indent: 1, level: "dim" },
		]);
	});

	it("names the model when the last reply came from another one", () => {
		expect(lines({ model: "openrouter/qwen/qwen3.8-27b", host: "Modal" }).map((line) => line.text)).toEqual(["OpenRouter host of the last reply on openrouter/qwen/qwen3.8-27b: Modal"]);
	});

	it("says nothing before a reply has named a host", () => {
		expect(lines(undefined)).toEqual([]);
	});
});
