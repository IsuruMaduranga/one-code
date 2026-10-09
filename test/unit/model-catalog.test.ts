import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bundledSources,
	catalogCacheDir,
	catalogFetchedAt,
	catalogRefreshDue,
	catalogRefreshEnabled,
	emptyCatalogSources,
	HUGGING_FACE_LOOKUPS_PER_REFRESH,
	loadCatalogSources,
	parameterCountFromResponse,
	refreshModelCatalog,
	setCatalogSourcesForTest,
	trimModelsDev,
	trimOpenRouter,
	unknownRepos,
} from "../../extensions/lib/model-catalog-data.ts";
import { autoSelectable, autoSelectSkipReason, bareId, buildCatalogIndex, catalogModelFor, sizeFromName } from "../../extensions/lib/model-catalog.ts";
import { catalogSources, type FixtureModel } from "./catalog-fixture.ts";

const entry = (models: FixtureModel[], id: string) => buildCatalogIndex(catalogSources(models)).models.get(id)!;

describe("the tier rules", () => {
	it("places by size when every current model of the vendor has one", () => {
		const models: FixtureModel[] = [
			{ id: "deepseek/big", released: "2026-08-01", price: [0.4, 0.9], params: 1.6e12 },
			{ id: "deepseek/half", released: "2026-08-01", price: [0.2, 0.4], params: 8e11 },
			{ id: "deepseek/flash", released: "2026-08-01", price: [0.1, 0.3], params: 2.8e11 },
			{ id: "deepseek/small", released: "2026-08-01", price: [0.05, 0.1], params: 3.9e10 },
		];
		expect(entry(models, "deepseek/big")).toMatchObject({ tier: "workhorse" });
		expect(entry(models, "deepseek/half")).toMatchObject({ tier: "workhorse", reason: "800B parameters, 0.50 of deepseek's largest current model (1.6T)" });
		expect(entry(models, "deepseek/flash")).toMatchObject({ tier: "cheap" });
		expect(entry(models, "deepseek/small")).toMatchObject({ tier: "tiny", reason: "39B parameters, under 40B" });
	});

	it("places by price against the median when a current model has no published size", () => {
		const models: FixtureModel[] = [
			{ id: "acme/flagship", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/flagship-pro", released: "2026-08-01", price: [30, 150] },
			{ id: "acme/flagship-fast", released: "2026-08-01", price: [6, 30] },
			{ id: "acme/mid", released: "2026-08-01", price: [1, 5] },
			{ id: "acme/flash", released: "2026-08-01", price: [0.3, 1.2] },
			{ id: "acme/open", released: "2026-08-01", price: [0.1, 0.4], params: 1.2e11 },
		];
		// Median of 6, 60, 12, 2, 0.525, 0.175 is 2: the -pro SKU does not move it.
		expect(entry(models, "acme/mid")).toMatchObject({ tier: "workhorse", reason: "$2.00/M blended, 1.00 of acme's median current price ($2.00)" });
		expect(entry(models, "acme/flash")).toMatchObject({ tier: "cheap" });
		// A sized model of a vendor with closed models is placed by price too.
		expect(entry(models, "acme/open")).toMatchObject({ tier: "cheap" });
	});

	it("needs three current priced models before a price can place anything", () => {
		const two: FixtureModel[] = [
			{ id: "acme/a", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/b", released: "2026-08-01", price: [0.3, 1.5] },
		];
		expect(entry(two, "acme/a")).toMatchObject({ tier: "cheap", reason: "acme has too few current priced models to compare against" });
	});

	it("reads tiny from a small-model name only when no size is published", () => {
		const models: FixtureModel[] = [
			{ id: "acme/one", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/two", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/one-nano", released: "2026-08-01", price: [0.05, 0.4] },
			{ id: "acme/two-lite", released: "2026-08-01", price: [0.1, 0.4], params: 1e11 },
		];
		expect(entry(models, "acme/one-nano").tier).toBe("tiny");
		expect(entry(models, "acme/two-lite").tier).not.toBe("tiny");
	});

	it("drops a workhorse model a year older than the vendor's newest workhorse to cheap, and never ages a model into tiny", () => {
		const models: FixtureModel[] = [
			{ id: "acme/new", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/newer", released: "2026-08-02", price: [3, 15] },
			{ id: "acme/newest", released: "2026-08-03", price: [3, 15] },
			{ id: "acme/old", released: "2025-07-01", price: [3, 15] },
			{ id: "acme/ancient", released: "2023-01-01", price: [0.01, 0.02] },
		];
		expect(entry(models, "acme/old")).toMatchObject({ tier: "cheap", reason: expect.stringContaining("over a year older") });
		expect(entry(models, "acme/ancient")).toMatchObject({ tier: "cheap", legacy: true });
	});

	it("supersedes a model with a newer one of its vendor in the same or a higher tier and price band, not with a cheaper sibling", () => {
		const models: FixtureModel[] = [
			{ id: "anthropic/opus-new", released: "2026-09-22", price: [4, 20] },
			{ id: "anthropic/opus-old", released: "2026-05-28", price: [5, 25] },
			{ id: "anthropic/sonnet-new", released: "2026-09-28", price: [2, 10] },
			{ id: "anthropic/fable", released: "2026-09-01", price: [10, 50] },
		];
		expect(entry(models, "anthropic/opus-old")).toMatchObject({ successors: ["anthropic/opus-new"] });
		// Sonnet is newer and half the price: a sibling, not a successor.
		expect(entry(models, "anthropic/opus-new").successors).toEqual([]);
		expect(entry(models, "anthropic/fable").successors).toEqual([]);
		const served = new Set(models.map((model) => model.id));
		expect(autoSelectSkipReason(entry(models, "anthropic/opus-old"), served)).toBe("superseded by anthropic/opus-new, which this provider serves");
		expect(autoSelectable(entry(models, "anthropic/opus-new"), served)).toBe(true);
	});

	it("never lets a moving alias or a model's own snapshot supersede it", () => {
		const models: FixtureModel[] = [
			{ id: "acme/big", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/mid", released: "2026-08-01", price: [1, 5] },
			{ id: "acme/coder-small", released: "2026-05-01", price: [0.1, 0.3] },
			{ id: "acme/chat-small-latest", released: "2026-07-15", price: [0.1, 0.3] },
			{ id: "acme/max", released: "2026-08-15", price: [1, 5] },
			{ id: "acme/max-0902", released: "2026-09-02", price: [1, 5] },
		];
		// The only newer model in its price band is an alias.
		expect(entry(models, "acme/coder-small").successors).toEqual([]);
		// The only newer one is its own dated snapshot.
		expect(entry(models, "acme/max").successors).toEqual([]);
		// Every qualifying successor, newest first.
		expect(entry(models, "acme/mid").successors).toEqual(["acme/max-0902", "acme/max"]);
	});

	it("skips a superseded model only when the pool serves its successor", () => {
		const models: FixtureModel[] = [
			{ id: "anthropic/opus-new", released: "2026-09-22", price: [4, 20] },
			{ id: "anthropic/opus-old", released: "2026-05-28", price: [5, 25] },
		];
		const old = entry(models, "anthropic/opus-old");
		expect(autoSelectSkipReason(old, new Set())).toBeUndefined();
		expect(autoSelectable(old, new Set(["anthropic/opus-old"]))).toBe(true);
		expect(autoSelectSkipReason(old, new Set(["anthropic/opus-new"]))).toBe("superseded by anthropic/opus-new, which this provider serves");
	});

	it("gives an alias the size of the dated model it names, so it is placed and compared like that model", () => {
		const models: FixtureModel[] = [
			{ id: "acme/big", released: "2026-08-01", price: [3, 15] },
			{ id: "acme/mid", released: "2026-08-01", price: [1, 5] },
			{ id: "acme/small", released: "2026-08-01", price: [0.4, 1.6] },
			{ id: "acme/coder-small-2507", released: "2026-05-01", price: [0.1, 0.3] },
			{ id: "acme/voice-small-24b-2507", released: "2026-07-15", price: [0.1, 0.3], params: 24e9 },
			{ id: "acme/voice-small-latest", released: "2026-07-15", price: [0.1, 0.3] },
		];
		expect(entry(models, "acme/voice-small-latest")).toMatchObject({
			tier: "tiny",
			params: 24e9,
			reason: "24B parameters (as acme/voice-small-24b-2507), under 40B",
		});
		// Neither the alias nor its tiny twin supersedes a cheap model.
		expect(entry(models, "acme/coder-small-2507").successors).toEqual([]);
	});

	it("reads an MoE size tag as active parameters, and takes the same model's measured size from its untagged row", () => {
		const sources = catalogSources([
			{ id: "meta/muse-big", released: "2026-08-01", price: [3, 15] },
			{ id: "meta/muse-mid", released: "2026-08-01", price: [1, 5] },
			{ id: "meta/muse-small", released: "2026-08-01", price: [0.4, 1.6] },
			{ id: "meta/llama-4-maverick-17b-instruct", released: "2025-04-05", price: [0.24, 0.97] },
			{ id: "meta/llama-4-maverick", released: "2025-04-05" },
			// A size ladder released together: each tag is that model's own total.
			{ id: "meta/gemma-like-4b", released: "2025-04-05", price: [0.02, 0.04] },
			{ id: "meta/gemma-like-27b", released: "2025-04-05", price: [0.1, 0.2] },
		]);
		// OpenRouter's untagged row of the same model, measured on Hugging Face.
		(sources.modelsDev.payload.openrouter ??= { models: {} }).models["meta-llama/llama-4-maverick"] = { release_date: "2025-04-05", cost: { input: 0.19, output: 0.65 } };
		(sources.modelsDev.payload.openrouter.models["meta-llama/gemma-like"] = { release_date: "2025-04-05" });
		sources.openRouter.payload.data.push({ id: "meta-llama/llama-4-maverick", hugging_face_id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct" });
		sources.openRouter.payload.data.push({ id: "meta-llama/gemma-like", hugging_face_id: "meta-llama/gemma-like-27b" });
		sources.huggingFace.payload["meta-llama/Llama-4-Maverick-17B-128E-Instruct"] = 401.6e9;
		sources.huggingFace.payload["meta-llama/gemma-like-27b"] = 27e9;
		const index = buildCatalogIndex(sources);
		expect(index.models.get("meta/llama-4-maverick-17b-instruct")).toMatchObject({ params: 401.6e9, tier: "cheap" });
		expect(index.models.get("meta/llama-4-maverick")).toMatchObject({ params: 401.6e9 });
		expect(index.models.get("meta/gemma-like-4b")).toMatchObject({ params: 4e9, tier: "tiny" });
	});

	it("keeps deprecated, tool-less and legacy models out of automatic selection", () => {
		const models: FixtureModel[] = [
			{ id: "acme/current", released: "2026-08-01", price: [1, 4] },
			{ id: "acme/gone", released: "2026-08-01", price: [1, 4], deprecated: true },
			{ id: "acme/no-tools", released: "2026-08-01", price: [1, 4], tools: false },
			{ id: "acme/legacy", released: "2024-01-01", price: [9, 40] },
		];
		expect(autoSelectSkipReason(entry(models, "acme/gone"), new Set())).toBe("deprecated");
		expect(autoSelectSkipReason(entry(models, "acme/no-tools"), new Set())).toBe("cannot call tools");
		expect(autoSelectSkipReason(entry(models, "acme/legacy"), new Set())).toBe("over two years older than its vendor's newest model");
	});
});

describe("matching pi rows to catalog models", () => {
	it("follows a hosted row's canonical id, and matches Codex and Azure rows through their identity", () => {
		const index = buildCatalogIndex(catalogSources([{ id: "openai/gpt-x", released: "2026-08-01", price: [1, 4], servedAs: ["amazon-bedrock/openai.gpt-x-v1:0"] }]));
		for (const row of [{ provider: "amazon-bedrock", id: "openai.gpt-x-v1:0" }, { provider: "openai-codex", id: "gpt-x" }, { provider: "azure-openai-responses", id: "gpt-x" }]) {
			expect(catalogModelFor(row, index)?.id, row.provider).toBe("openai/gpt-x");
		}
	});

	it("matches a host by bare id only when one vendor has it", () => {
		const one = buildCatalogIndex(catalogSources([{ id: "zhipuai/glm-9", released: "2026-08-01" }]));
		expect(catalogModelFor({ provider: "fireworks", id: "accounts/fireworks/models/glm-9" }, one)?.id).toBe("zhipuai/glm-9");
		expect(bareId("accounts/fireworks/models/glm-5p3")).toBe("glm-5.3");
		const two = buildCatalogIndex(catalogSources([{ id: "zhipuai/glm-9", released: "2026-08-01" }, { id: "other/glm-9", released: "2026-08-01" }]));
		expect(catalogModelFor({ provider: "fireworks", id: "glm-9" }, two)).toBeUndefined();
	});

	it("never matches a custom provider", () => {
		const index = buildCatalogIndex(catalogSources([{ id: "anthropic/claude-sonnet-9", released: "2026-08-01" }]));
		expect(catalogModelFor({ provider: "ollama", id: "claude-sonnet-9" }, index)).toBeUndefined();
	});

	it("keys a gateway row no vendor row names on its own vendor/id, against that vendor's models", () => {
		const sources = catalogSources([
			{ id: "zhipuai/glm-5", released: "2026-08-01", price: [1, 3] },
			{ id: "zhipuai/glm-5-air", released: "2026-08-01", price: [0.1, 0.4] },
			{ id: "zhipuai/glm-5-max", released: "2026-08-01", price: [2, 6] },
		]);
		(sources.modelsDev.payload.openrouter ??= { models: {} }).models["z-ai/glm-5-prime"] = { release_date: "2026-08-10", cost: { input: 4, output: 12 } };
		const index = buildCatalogIndex(sources);
		const prime = catalogModelFor({ provider: "openrouter", id: "z-ai/glm-5-prime" }, index);
		expect(prime).toMatchObject({ id: "z-ai/glm-5-prime", derived: true, tier: "workhorse", reason: expect.stringContaining("zhipuai's median") });
		// A derived row is placed against the vendor, never supersedes a vendor model.
		expect(index.models.get("zhipuai/glm-5-max")?.successors).toEqual([]);
	});

	it("skips a host's nested copy of another vendor's model", () => {
		const sources = catalogSources([{ id: "moonshotai/kimi-k9", released: "2026-08-01" }]);
		sources.modelsDev.payload.nvidia = { models: { "moonshotai/kimi-k9": { canonical_model_id: "nvidia/moonshotai/kimi-k9", release_date: "2026-08-02" } } };
		const index = buildCatalogIndex(sources);
		expect(index.models.has("nvidia/moonshotai/kimi-k9")).toBe(false);
		expect(catalogModelFor({ provider: "nvidia", id: "moonshotai/kimi-k9" }, index)?.id).toBe("moonshotai/kimi-k9");
	});

	it("reads sizes from size tags, including Gemma's effective sizes", () => {
		expect(sizeFromName("qwen3.8-27b")).toBe(27e9);
		expect(sizeFromName("gemma-4-E2B-it")).toBe(2e9);
		expect(sizeFromName("qwen3.6-35b-a3b")).toBe(35e9);
		expect(sizeFromName("mixtral-8x7b")).toBeUndefined();
		// Llama 4 names its active parameters and expert count, not its total.
		expect(sizeFromName("@cf/meta/llama-4-scout-17b-16e-instruct")).toBeUndefined();
		expect(sizeFromName("llama-4-maverick-17b-128e-instruct-fp8")).toBeUndefined();
	});
});

describe("the payloads", () => {
	it("trims models.dev to pi's providers, OpenRouter, and every vendor they name, in the API's shape", () => {
		const body = {
			openrouter: { models: { "acme/x": { canonical_model_id: "acme/x", release_date: "2026-08-01", description: "dropped", limit: { context: 1 } } } },
			deepseek: { models: { "deepseek-v9": { tool_call: true, cost: { input: 0.1, output: 0.2, cache_read: 0.01 }, modalities: { input: ["text"], output: ["text"] } } } },
			acme: { models: { x: { release_date: "2026-08-01", status: "deprecated", modalities: { output: ["text", "image"] } }, y: {} } },
			unrelated: { models: { z: {} } },
		};
		expect(trimModelsDev(body, ["deepseek"])).toEqual({
			acme: { models: { x: { release_date: "2026-08-01", status: "deprecated", modalities: { output: ["text", "image"] } }, y: {} } },
			deepseek: { models: { "deepseek-v9": { tool_call: true, cost: { input: 0.1, output: 0.2 } } } },
			openrouter: { models: { "acme/x": { canonical_model_id: "acme/x", release_date: "2026-08-01" } } },
		});
	});

	it("trims OpenRouter to ids, dates, Hugging Face ids, tool support, non-text outputs and prices", () => {
		const body = {
			data: [
				{ id: "b/y", created: 2, hugging_face_id: "", supported_parameters: ["temperature"], architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000002" }, description: "x" },
				{ id: "a/x", created: 1, hugging_face_id: "org/x", supported_parameters: ["tools", "top_p"], architecture: { output_modalities: ["image"] } },
			],
		};
		expect(trimOpenRouter(body)).toEqual({
			data: [
				{ id: "a/x", created: 1, hugging_face_id: "org/x", supported_parameters: ["tools"], architecture: { output_modalities: ["image"] } },
				{ id: "b/y", created: 2, pricing: { prompt: "0.000001", completion: "0.000002" } },
			],
		});
		expect(unknownRepos(trimOpenRouter(body), {})).toEqual(["org/x"]);
		expect(unknownRepos(trimOpenRouter(body), { "org/x": null })).toEqual([]);
	});

	it("reads a Hugging Face total parameter count", () => {
		expect(parameterCountFromResponse({ safetensors: { total: 27e9 } })).toBe(27e9);
		expect(parameterCountFromResponse({ safetensors: {} })).toBeNull();
		expect(parameterCountFromResponse(null)).toBeNull();
	});

	it("bundles a usable copy of each catalog with the release", () => {
		const sources = bundledSources();
		expect(Object.keys(sources.modelsDev.payload).length).toBeGreaterThan(10);
		expect(sources.openRouter.payload.data.length).toBeGreaterThan(100);
		expect(Object.keys(sources.huggingFace.payload).length).toBeGreaterThan(50);
	});
});

describe("refreshing the catalogs", () => {
	let stateDir: string;
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "onecode-catalog-"));
		setCatalogSourcesForTest(undefined);
	});
	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
		setCatalogSourcesForTest(emptyCatalogSources());
	});

	const now = new Date("2099-01-01T00:00:00Z");
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fakeFetch = (overrides: Record<string, () => Response> = {}) => {
		const calls: string[] = [];
		const impl = (async (url: string | URL) => {
			const href = String(url);
			calls.push(href);
			for (const [prefix, respond] of Object.entries(overrides)) if (href.startsWith(prefix)) return respond();
			if (href.startsWith("https://models.dev/")) return json({ deepseek: { models: { "deepseek-v9": { canonical_model_id: "deepseek/deepseek-v9", release_date: "2098-12-01" } } } });
			if (href.startsWith("https://openrouter.ai/")) {
				return json({ data: Array.from({ length: 30 }, (_, i) => ({ id: `deepseek/m${i}`, hugging_face_id: `org/m${i}` })) });
			}
			if (href.includes("org/m0")) return json({ safetensors: { total: 7e11 } });
			return json({}, 404);
		}) as typeof fetch;
		return { impl, calls };
	};

	it("writes all three payloads to the cache, and the newer copy wins over the bundled one", async () => {
		const { impl, calls } = fakeFetch();
		const outcome = await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: impl, now });
		expect(outcome).toEqual({ status: "refreshed", models: 1, repos: HUGGING_FACE_LOOKUPS_PER_REFRESH });
		expect(calls.filter((url) => url.startsWith("https://huggingface.co/"))).toHaveLength(HUGGING_FACE_LOOKUPS_PER_REFRESH);
		const counts = JSON.parse(readFileSync(join(catalogCacheDir(stateDir), "huggingface.json"), "utf8")).payload;
		expect(counts["org/m0"]).toBe(7e11);
		expect(counts["org/m1"]).toBeNull();
		const sources = loadCatalogSources(stateDir);
		expect(sources.refreshed).toBe(true);
		expect(sources.modelsDev.payload.deepseek.models["deepseek-v9"]).toBeDefined();
		// Parameter counts merge: the bundled repos stay known.
		expect(Object.keys(sources.huggingFace.payload).length).toBeGreaterThan(HUGGING_FACE_LOOKUPS_PER_REFRESH);
		// Fresh for a day.
		expect(await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: impl, now })).toEqual({ status: "fresh" });
	});

	it("keeps the copy on disk when a fetch fails or comes back empty", async () => {
		await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch().impl, now });
		const before = readFileSync(join(catalogCacheDir(stateDir), "models-dev.json"), "utf8");
		const later = new Date("2099-01-03T00:00:00Z");
		const failed = await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch({ "https://openrouter.ai/": () => json({}, 503) }).impl, now: later });
		expect(failed).toEqual({ status: "failed", error: "openrouter.ai responded 503" });
		const dayAfter = new Date("2099-01-04T00:00:01Z");
		const empty = await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch({ "https://models.dev/": () => json({}) }).impl, now: dayAfter });
		expect(empty).toEqual({ status: "failed", error: "a model catalog came back empty" });
		expect(readFileSync(join(catalogCacheDir(stateDir), "models-dev.json"), "utf8")).toBe(before);
	});

	it("after a failure, waits a day before trying again, and a success clears the wait", async () => {
		const later = new Date("2099-01-03T00:00:00Z");
		const down = fakeFetch({ "https://models.dev/": () => json({}, 503) });
		expect(catalogRefreshDue(stateDir, later)).toBe(true);
		expect(await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: down.impl, now: later })).toEqual({ status: "failed", error: "models.dev responded 503" });
		const calls = down.calls.length;
		const soon = new Date("2099-01-03T12:00:00Z");
		expect(catalogRefreshDue(stateDir, soon)).toBe(false);
		expect(await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: down.impl, now: soon })).toEqual({
			status: "backing-off",
			error: "models.dev responded 503",
		});
		expect(down.calls.length).toBe(calls);
		const nextDay = new Date("2099-01-04T00:00:01Z");
		expect(catalogRefreshDue(stateDir, nextDay)).toBe(true);
		expect((await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch().impl, now: nextDay })).status).toBe("refreshed");
		expect(existsSync(join(catalogCacheDir(stateDir), "refresh-failed.json"))).toBe(false);
	});

	it("ignores a failure stamped later than now, so it cannot hold refreshes off", async () => {
		const later = new Date("2099-01-03T00:00:00Z");
		mkdirSync(catalogCacheDir(stateDir), { recursive: true });
		writeFileSync(join(catalogCacheDir(stateDir), "refresh-failed.json"), JSON.stringify({ failedAt: "9999-01-01T00:00:00Z", error: "x" }));
		expect(catalogRefreshDue(stateDir, later)).toBe(true);
		expect((await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch().impl, now: later })).status).toBe("refreshed");
	});

	it("does not count a refresh the caller cancelled as a failure", async () => {
		const controller = new AbortController();
		const stalled = (async () => new Response(new ReadableStream({ start() {} }), { status: 200 })) as typeof fetch;
		const pending = refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: stalled, now, signal: controller.signal });
		controller.abort(new Error("session ended"));
		expect(await pending).toEqual({ status: "failed", error: "session ended" });
		expect(catalogRefreshDue(stateDir, now)).toBe(true);
	});

	it("writes models.dev last, so a failed write never leaves a fresh-looking mixed copy", async () => {
		// A directory where openrouter.json goes makes that write throw.
		mkdirSync(join(catalogCacheDir(stateDir), "openrouter.json"), { recursive: true });
		const outcome = await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch().impl, now });
		expect(outcome.status).toBe("failed");
		expect(existsSync(join(catalogCacheDir(stateDir), "models-dev.json"))).toBe(false);
	});

	it("reads when the copy in use was fetched without parsing the catalogs", async () => {
		expect(catalogFetchedAt(stateDir)).toBe(bundledSources().modelsDev.fetchedAt);
		await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch().impl, now });
		expect(catalogFetchedAt(stateDir)).toBe(now.toISOString());
		expect(catalogFetchedAt(stateDir)).toBe(loadCatalogSources(stateDir).modelsDev.fetchedAt);
	});

	it("never fetches while a test has pinned the catalog", async () => {
		setCatalogSourcesForTest(emptyCatalogSources());
		const { impl, calls } = fakeFetch();
		expect(await refreshModelCatalog({ stateDir, piProviders: [], fetchImpl: impl, now })).toEqual({ status: "fresh" });
		expect(calls).toEqual([]);
	});

	it("is due after a day, and off with refreshModelCatalog: false or PI_OFFLINE", async () => {
		await refreshModelCatalog({ stateDir, piProviders: ["deepseek"], fetchImpl: fakeFetch().impl, now });
		expect(catalogRefreshDue(stateDir, new Date("2099-01-01T23:00:00Z"))).toBe(false);
		expect(catalogRefreshDue(stateDir, new Date("2099-01-02T01:00:00Z"))).toBe(true);
		expect(catalogRefreshEnabled({}, {})).toBe(true);
		expect(catalogRefreshEnabled({ refreshModelCatalog: false }, {})).toBe(false);
		expect(catalogRefreshEnabled({}, { PI_OFFLINE: "1" })).toBe(false);
	});
});
