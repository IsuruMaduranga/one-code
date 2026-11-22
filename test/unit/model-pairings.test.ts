import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { bundledSources, setCatalogSourcesForTest } from "../../extensions/lib/models/model-catalog-data.ts";
import { currentCatalog } from "../../extensions/lib/models/model-catalog.ts";
import { PAIRING_BARS, PAIRING_TABLE, PAIRINGS_AS_OF, pairedModel } from "../../extensions/lib/models/model-pairings.ts";
import { catalogSources, type FixtureModel, pinCatalog } from "./catalog-fixture.ts";

const model = (provider: string, id: string, input: number, extra: Partial<Model<Api>> = {}) =>
	({ provider, id, name: id, contextWindow: 1_000_000, maxTokens: 64_000, input: ["text", "image"], cost: { input, output: input * 5 }, ...extra }) as unknown as Model<Api>;

const ANTHROPIC: FixtureModel[] = [
	{ id: "anthropic/claude-opus-5-5", released: "2026-09-22", price: [4, 20], servedAs: ["openrouter/anthropic/claude-opus-5.5"] },
	{ id: "anthropic/claude-sonnet-5-5", released: "2026-09-28", price: [2, 10], servedAs: ["openrouter/anthropic/claude-sonnet-5.5"] },
	{ id: "anthropic/claude-haiku-5-5", released: "2026-10-07", price: [0.1, 0.5] },
];
const KIMI: FixtureModel[] = [
	{ id: "moonshotai/kimi-k3.1-pro", released: "2026-10-23", price: [2, 10] },
	{ id: "moonshotai/kimi-k2.7-code", released: "2026-06-12", price: [0.95, 4] },
];

const opus = model("anthropic", "claude-opus-5-5", 4);
const sonnet = model("anthropic", "claude-sonnet-5-5", 2);
const haiku = model("anthropic", "claude-haiku-5-5", 0.1);

afterEach(() => setCatalogSourcesForTest(undefined));

describe("pairedModel", () => {
	it("hands an Opus session's subagents and classifier to Sonnet 5.5 and a Sonnet 5.5 session's classifier to Haiku 5.5", () => {
		pinCatalog(ANTHROPIC);
		const pool = [opus, sonnet, haiku];
		expect(pairedModel("subagent", pool, opus)).toEqual({ kind: "model", model: sonnet });
		expect(pairedModel("classifier", pool, opus)).toEqual({ kind: "model", model: sonnet });
		expect(pairedModel("subagent", pool, sonnet)).toEqual({ kind: "session" });
		expect(pairedModel("classifier", pool, sonnet)).toEqual({ kind: "model", model: haiku });
	});

	it("keeps the session model where the row says so, overriding a cheaper candidate", () => {
		pinCatalog([...ANTHROPIC, ...KIMI]);
		expect(pairedModel("classifier", [opus, sonnet, haiku], haiku)).toEqual({ kind: "session" });
		const k31 = model("moonshotai", "kimi-k3.1-pro", 2);
		expect(pairedModel("subagent", [k31, model("moonshotai", "kimi-k2.7-code", 0.95)], k31)).toEqual({ kind: "session" });
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
		expect(pairedModel("classifier", [opus, sonnet, haiku], sonnet, { accept: (m) => m.id !== haiku.id })).toBeUndefined();
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
		expect(pairedModel("classifier", [opus, sonnet, dearHaiku], sonnet)).toBeUndefined();
		const sameHaiku = model("anthropic", "claude-haiku-5-5", 2);
		expect(pairedModel("classifier", [opus, sonnet, sameHaiku], sonnet)).toEqual({ kind: "model", model: sameHaiku });
	});

	it("picks a later release whose id reads as a dated snapshot of an older listed model", () => {
		pinCatalog([
			{ id: "deepseek/deepseek-v4-pro-0813", released: "2026-08-13", price: [1.32, 3.96], servedAs: ["openrouter/deepseek/deepseek-v4-pro-0813"] },
			{ id: "deepseek/deepseek-v4.1-flash", released: "2026-09-10", price: [0.3, 1.2], servedAs: ["openrouter/deepseek/deepseek-v4.1-flash"] },
			{ id: "deepseek/deepseek-v4.1-flash-1017", released: "2026-10-17", price: [0.3, 1.2], servedAs: ["openrouter/deepseek/deepseek-v4.1-flash-1017"] },
		]);
		const session = model("openrouter", "deepseek/deepseek-v4-pro-0813", 1.32);
		const older = model("openrouter", "deepseek/deepseek-v4.1-flash", 0.3);
		const flash1017 = model("openrouter", "deepseek/deepseek-v4.1-flash-1017", 0.3);
		const pool = [session, older, flash1017];
		expect(pairedModel("subagent", pool, session)).toEqual({ kind: "model", model: flash1017 });
		expect(pairedModel("classifier", pool, session)).toEqual({ kind: "model", model: flash1017 });
	});

	it("reads a gateway's unversioned id as the vendor's versioned model, for picks and sessions alike", () => {
		const sources = catalogSources([
			{ id: "meta/muse-spark-1.3", released: "2026-09-02", price: [1.25, 4.25], servedAs: ["openrouter/meta/muse-spark-1.3"] },
			{ id: "meta/muse-ember-1.0", released: "2026-11-09", price: [0.1, 0.5] },
			{ id: "meta/muse-wonder-1.0", released: "2026-10-12", price: [4, 20] },
		]);
		const openrouter = (sources.modelsDev.payload.openrouter ??= { models: {} }).models;
		openrouter["meta/muse-ember"] = { release_date: "2026-11-09" };
		openrouter["meta/muse-wonder"] = { release_date: "2026-10-12" };
		setCatalogSourcesForTest(sources);
		const spark = model("openrouter", "meta/muse-spark-1.3", 1.25);
		const ember = model("openrouter", "meta/muse-ember", 0.1);
		const wonder = model("openrouter", "meta/muse-wonder", 4);
		const pool = [spark, ember, wonder];
		expect(pairedModel("subagent", pool, spark)).toEqual({ kind: "model", model: ember });
		expect(pairedModel("classifier", pool, spark)).toEqual({ kind: "model", model: ember });
		expect(pairedModel("subagent", pool, wonder)).toEqual({ kind: "model", model: ember });
		expect(pairedModel("classifier", pool, wonder)).toEqual({ kind: "model", model: ember });
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

	it("names only models the bundled catalog knows", () => {
		setCatalogSourcesForTest(bundledSources());
		const known = currentCatalog().models;
		expect(tableIds().filter((id) => !known.has(id))).toEqual([]);
	});

	it("never picks a tiny model, which automatic selection never lands on", () => {
		setCatalogSourcesForTest(bundledSources());
		const known = currentCatalog().models;
		const picks = [...new Set(PAIRING_TABLE.flatMap((row) => [row.subagent, row.classifier]))].filter((id) => id !== "session");
		expect(picks.filter((id) => known.get(id)?.tier === "tiny")).toEqual([]);
	});
});

// The scores the table was built from (Artificial Analysis Intelligence Index v5.0.1, one decimal).
interface ScoredModel {
	id: string;
	max: number | null;
	low: number | null;
	price: [number, number] | null;
	deprecated: boolean;
}
interface Override {
	session: string;
	role: "subagent" | "classifier";
	pick: string;
}
const SCORES: { asOf: string; overrides: Override[]; models: ScoredModel[] } = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pairing-scores.json"), "utf8"),
);
const SCORED = new Map(SCORES.models.map((entry) => [entry.id, entry]));
const tableIds = () => [...new Set(PAIRING_TABLE.flatMap((row) => [...row.sessions, row.subagent, row.classifier]))].filter((id) => id !== "session");
const vendorOf = (id: string) => id.slice(0, id.indexOf("/"));
/** Scores are compared as published, to one decimal: 25.6 - 18.6 is 7.0, not 7.000000000000002. */
const gap = (session: number, candidate: number) => Math.round((session - candidate) * 10) / 10;
/** List price blended 3 input to 1 output, the catalog's blend. */
const blended = (entry: ScoredModel) => (entry.price ? (3 * entry.price[0] + entry.price[1]) / 4 : Number.POSITIVE_INFINITY);

/** The rule in the module header: the cheapest scored, current, non-tiny same-vendor model within the bar, else the session. */
function derivedPick(sessionId: string, role: "subagent" | "classifier", isTiny: (id: string) => boolean, models: ScoredModel[] = SCORES.models): string {
	const session = models.find((entry) => entry.id === sessionId);
	if (!session || session.max === null) throw new Error(`${sessionId} has no score`);
	const within = (candidate: ScoredModel) => {
		if (candidate.max === null) return false;
		if (role === "subagent") return gap(session.max as number, candidate.max) <= PAIRING_BARS.subagent;
		// No low-effort score on either side: the classifier bar compares maximum-effort scores.
		if (session.low === null || candidate.low === null) return gap(session.max as number, candidate.max) <= PAIRING_BARS.classifierMax;
		return gap(session.low, candidate.low) <= PAIRING_BARS.classifierLow;
	};
	const candidates = models
		.filter((candidate) => candidate.id !== sessionId && vendorOf(candidate.id) === vendorOf(sessionId))
		.filter((candidate) => !candidate.deprecated && !isTiny(candidate.id) && within(candidate))
		.sort((a, b) => blended(a) - blended(b));
	const cheapest = candidates[0];
	return cheapest && blended(cheapest) < blended(session) ? cheapest.id : "session";
}

describe("PAIRING_TABLE against its scores", () => {
	const tinyInBundledCatalog = () => {
		setCatalogSourcesForTest(bundledSources());
		const known = currentCatalog().models;
		return (id: string) => known.get(id)?.tier === "tiny";
	};
	const noneTiny = () => false;
	const scored = (id: string, max: number, low: number | null, input: number, deprecated = false): ScoredModel => ({ id, max, low, price: [input, input * 5], deprecated });

	it("is dated with its scores", () => {
		expect(PAIRINGS_AS_OF).toBe(SCORES.asOf);
	});

	it("derives every row from the scores by the rule, the listed overrides aside", () => {
		const isTiny = tinyInBundledCatalog();
		const mismatches: string[] = [];
		for (const row of PAIRING_TABLE) {
			for (const session of row.sessions) {
				for (const role of ["subagent", "classifier"] as const) {
					const override = SCORES.overrides.find((entry) => entry.session === session && entry.role === role);
					const expected = override ? override.pick : derivedPick(session, role, isTiny);
					if (row[role] !== expected) mismatches.push(`${session} ${role}: table ${row[role]}, rule ${expected}`);
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("names only scored models, and gives an unscored model no row", () => {
		expect(tableIds().filter((id) => SCORED.get(id)?.max == null)).toEqual([]);
		const unscored = SCORES.models.filter((entry) => entry.max === null).map((entry) => entry.id);
		expect(unscored).toEqual(expect.arrayContaining(["anthropic/claude-fable-5", "anthropic/claude-opus-4-8", "anthropic/claude-sonnet-5", "deepseek/deepseek-v4-flash"]));
		const sessions = new Set(PAIRING_TABLE.flatMap((row) => row.sessions));
		expect(unscored.filter((id) => sessions.has(id))).toEqual([]);
	});

	it("never picks a deprecated model, however close and cheap", () => {
		// A listed override is the user's own call and is checked by its own test below; the rule's picks are never deprecated.
		const overridden = (session: string, role: "subagent" | "classifier") => SCORES.overrides.some((entry) => entry.session === session && entry.role === role);
		const picks = PAIRING_TABLE.flatMap((row) =>
			(["subagent", "classifier"] as const).filter((role) => !row.sessions.every((session) => overridden(session, role))).map((role) => row[role]),
		).filter((id) => id !== "session");
		expect([...new Set(picks)].filter((id) => SCORED.get(id)?.deprecated)).toEqual([]);
		const models = [scored("v/big", 50, 40, 4), scored("v/old", 49, 39, 0.1, true), scored("v/mid", 45, 35, 1)];
		expect(derivedPick("v/big", "classifier", noneTiny, models)).toBe("v/mid");
		expect(derivedPick("v/big", "subagent", noneTiny, models)).toBe("v/mid");
	});

	it("counts a gap of exactly each bar, rounded to one decimal, as within it", () => {
		const onBar = (sessionLow: number | null, candidateLow: number | null, maxGap: number) => [
			scored("v/session", 60.3, sessionLow, 4),
			scored("v/pick", Math.round((60.3 - maxGap) * 10) / 10, candidateLow, 1),
		];
		// Classifier at low effort: 10.0 below qualifies, 10.1 does not.
		expect(derivedPick("v/session", "classifier", noneTiny, onBar(35.3, 25.3, 30))).toBe("v/pick");
		expect(derivedPick("v/session", "classifier", noneTiny, onBar(35.3, 25.2, 0))).toBe("session");
		// Classifier on maximum-effort scores (no low-effort score): 14.0 qualifies, 14.1 does not.
		expect(derivedPick("v/session", "classifier", noneTiny, onBar(null, null, 14))).toBe("v/pick");
		expect(derivedPick("v/session", "classifier", noneTiny, onBar(null, 20, 14.1))).toBe("session");
		// Subagent at maximum effort: exactly the bar qualifies, a tenth more does not.
		expect(derivedPick("v/session", "subagent", noneTiny, onBar(null, null, PAIRING_BARS.subagent))).toBe("v/pick");
		expect(derivedPick("v/session", "subagent", noneTiny, onBar(null, null, PAIRING_BARS.subagent + 0.1))).toBe("session");
		expect(PAIRING_BARS.subagent).toBe(15);
		expect(PAIRING_BARS.classifierLow).toBe(10);
		expect(PAIRING_BARS.classifierMax).toBe(14);
	});

	it("compares maximum-effort scores for the classifier where a side has no low-effort score", () => {
		const isTiny = tinyInBundledCatalog();
		// Opus 5 (44.2, no low score): Haiku 5.5 is 7.7 below at maximum effort, within 14.
		expect(derivedPick("anthropic/claude-opus-5", "classifier", isTiny)).toBe("anthropic/claude-haiku-5-5");
		// DeepSeek publishes no low-effort scores: V4.1 Flash 1017 (32.6) is above V4 Pro (23.1).
		expect(derivedPick("deepseek/deepseek-v4-pro-0813", "classifier", isTiny)).toBe("deepseek/deepseek-v4.1-flash-1017");
		// Fable 5.2 has a low-effort score, and its nearest current model there, Opus 5.5, is 19.1 below: it screens itself.
		expect(gap(53.9, 34.8)).toBe(19.1);
		expect(derivedPick("anthropic/claude-fable-5-2", "classifier", isTiny)).toBe("session");
	});

	it("screens Gemini 4 Argon with Gemini 4 Hydrogen, the rule's pick, with no override left", () => {
		const isTiny = tinyInBundledCatalog();
		expect(derivedPick("google/gemini-4-argon", "classifier", isTiny)).toBe("google/gemini-4-hydrogen");
		expect(SCORES.overrides).toEqual([]);
		expect(PAIRING_TABLE.find((row) => row.sessions.includes("google/gemini-4-argon"))?.classifier).toBe("google/gemini-4-hydrogen");
	});
});
