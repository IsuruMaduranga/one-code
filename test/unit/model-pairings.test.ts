import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { bundledSources, setCatalogSourcesForTest } from "../../extensions/lib/model-catalog-data.ts";
import { currentCatalog } from "../../extensions/lib/model-catalog.ts";
import { PAIRING_TABLE, PAIRINGS_AS_OF, pairedModel } from "../../extensions/lib/model-pairings.ts";
import { type FixtureModel, pinCatalog } from "./catalog-fixture.ts";

const model = (provider: string, id: string, input: number, extra: Partial<Model<Api>> = {}) =>
	({ provider, id, name: id, contextWindow: 1_000_000, maxTokens: 64_000, input: ["text", "image"], cost: { input, output: input * 5 }, ...extra }) as unknown as Model<Api>;

const ANTHROPIC: FixtureModel[] = [
	{ id: "anthropic/claude-opus-5-5", released: "2026-09-22", price: [4, 20], servedAs: ["openrouter/anthropic/claude-opus-5.5"] },
	{ id: "anthropic/claude-sonnet-5-5", released: "2026-09-28", price: [2, 10], servedAs: ["openrouter/anthropic/claude-sonnet-5.5"] },
	{ id: "anthropic/claude-haiku-5-5", released: "2026-10-07", price: [0.1, 0.5] },
];
const KIMI: FixtureModel[] = [
	{ id: "moonshotai/kimi-k3", released: "2026-07-15", price: [3, 15] },
	{ id: "moonshotai/kimi-k2.7-code", released: "2026-06-12", price: [0.95, 4] },
];

const opus = model("anthropic", "claude-opus-5-5", 4);
const sonnet = model("anthropic", "claude-sonnet-5-5", 2);
const haiku = model("anthropic", "claude-haiku-5-5", 0.1);

afterEach(() => setCatalogSourcesForTest(undefined));

describe("pairedModel", () => {
	it("hands an Opus session's subagents and classifier to Sonnet 5.5", () => {
		pinCatalog(ANTHROPIC);
		const pool = [opus, sonnet, haiku];
		expect(pairedModel("subagent", pool, opus)).toEqual({ kind: "model", model: sonnet });
		expect(pairedModel("classifier", pool, opus)).toEqual({ kind: "model", model: sonnet });
		expect(pairedModel("subagent", pool, sonnet)).toEqual({ kind: "model", model: haiku });
	});

	it("keeps the session model where the row says so, overriding a cheaper candidate", () => {
		pinCatalog([...ANTHROPIC, ...KIMI]);
		expect(pairedModel("classifier", [opus, sonnet, haiku], haiku)).toEqual({ kind: "session" });
		const k3 = model("moonshotai", "kimi-k3", 3);
		expect(pairedModel("subagent", [k3, model("moonshotai", "kimi-k2.7-code", 0.95)], k3)).toEqual({ kind: "session" });
	});

	it("leaves a session model the table does not name to the cost algorithm", () => {
		pinCatalog([...ANTHROPIC, { id: "anthropic/claude-opus-4-9", released: "2026-09-01", price: [4, 20] }]);
		const unnamed = model("anthropic", "claude-opus-4-9", 4);
		expect(pairedModel("subagent", [unnamed, sonnet, haiku], unnamed)).toBeUndefined();
	});

	it("steps aside for a vendor once its provider serves a model newer than the table", () => {
		const newer: FixtureModel = { id: "anthropic/claude-sonnet-6", released: "2026-12-01", price: [2, 10] };
		pinCatalog([...ANTHROPIC, newer, ...KIMI, { id: "moonshotai/kimi-k4", released: "2026-12-01", price: [3, 15] }]);
		const sonnet6 = model("anthropic", "claude-sonnet-6", 2);
		expect(pairedModel("subagent", [opus, sonnet, haiku, sonnet6], opus)).toBeUndefined();
		// Another vendor's new model, or one this provider does not serve, changes nothing.
		expect(pairedModel("subagent", [opus, sonnet, haiku, model("openrouter", "moonshotai/kimi-k4", 3)], opus)).toEqual({ kind: "model", model: sonnet });
		expect(pairedModel("subagent", [opus, sonnet, haiku], opus)).toEqual({ kind: "model", model: sonnet });
	});

	it("steps aside for a vendor's new dated snapshot listed beside an older undated alias", () => {
		pinCatalog([...ANTHROPIC, { id: "anthropic/claude-haiku-5-5-20261201", released: "2026-12-01", price: [0.1, 0.5] }]);
		const snapshot = model("anthropic", "claude-haiku-5-5-20261201", 0.1);
		expect(pairedModel("subagent", [opus, sonnet, haiku, snapshot], opus)).toBeUndefined();
	});

	it("falls through when the pick is not served or fails the caller's gate", () => {
		pinCatalog(ANTHROPIC);
		expect(pairedModel("subagent", [opus, haiku], opus)).toBeUndefined();
		expect(pairedModel("classifier", [opus, sonnet, haiku], opus, { accept: (m) => m.id !== sonnet.id })).toBeUndefined();
	});

	it("resolves a pick on a gateway to the same gateway's row, never its batch variant", () => {
		pinCatalog(ANTHROPIC);
		const orOpus = model("openrouter", "anthropic/claude-opus-5.5", 4);
		const orSonnet = model("openrouter", "anthropic/claude-sonnet-5.5", 2);
		const orBatch = model("openrouter", "anthropic/claude-sonnet-5.5:batch", 1);
		expect(pairedModel("subagent", [orOpus, orBatch, orSonnet, sonnet], orOpus)).toEqual({ kind: "model", model: orSonnet });
	});

	it("picks on a route with no list prices, which the cost algorithm cannot rank", () => {
		pinCatalog(ANTHROPIC);
		const unpriced = (m: Model<Api>) => ({ ...m, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as Model<Api>;
		const [planOpus, planSonnet, planHaiku] = [opus, sonnet, haiku].map(unpriced);
		expect(pairedModel("subagent", [planOpus, planSonnet, planHaiku], planOpus)).toEqual({ kind: "model", model: planSonnet });
	});

	it("skips a pick its route prices above the session model", () => {
		pinCatalog(ANTHROPIC);
		// A route can price an older model below its successor.
		const dearHaiku = model("anthropic", "claude-haiku-5-5", 3);
		expect(pairedModel("subagent", [opus, sonnet, dearHaiku], sonnet)).toBeUndefined();
		const sameHaiku = model("anthropic", "claude-haiku-5-5", 2);
		expect(pairedModel("subagent", [opus, sonnet, sameHaiku], sonnet)).toEqual({ kind: "model", model: sameHaiku });
	});

	it("drops a pick that fails the image gate", () => {
		pinCatalog(ANTHROPIC);
		const withoutImages = { ...sonnet, input: ["text"] } as Model<Api>;
		expect(pairedModel("subagent", [opus, withoutImages, haiku], opus, { requireImageInput: true })).toBeUndefined();
	});
});

describe("PAIRING_TABLE", () => {
	it("names each session model once, keeps every row to one vendor, and dates its data", () => {
		const sessions = PAIRING_TABLE.flatMap((row) => row.sessions);
		expect(new Set(sessions).size).toBe(sessions.length);
		const vendor = (id: string) => id.slice(0, id.indexOf("/"));
		for (const row of PAIRING_TABLE) {
			const vendors = new Set([...row.sessions, row.subagent, row.classifier].filter((id) => id !== "session").map(vendor));
			expect(vendors.size, row.sessions.join(", ")).toBe(1);
		}
		expect(Number.isNaN(Date.parse(PAIRINGS_AS_OF))).toBe(false);
	});

	it("names only models the bundled catalog knows (Gemini 4 Argon is not listed yet)", () => {
		setCatalogSourcesForTest(bundledSources());
		const known = currentCatalog().models;
		const ids = [...new Set(PAIRING_TABLE.flatMap((row) => [...row.sessions, row.subagent, row.classifier]))].filter((id) => id !== "session");
		expect(ids.filter((id) => !known.has(id) && id !== "google/gemini-4-argon")).toEqual([]);
	});

	it("never picks a tiny model, which automatic selection never lands on", () => {
		setCatalogSourcesForTest(bundledSources());
		const known = currentCatalog().models;
		const picks = [...new Set(PAIRING_TABLE.flatMap((row) => [row.subagent, row.classifier]))].filter((id) => id !== "session");
		expect(picks.filter((id) => known.get(id)?.tier === "tiny")).toEqual([]);
	});
});
