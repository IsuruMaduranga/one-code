import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { modelLine, newerModelSuggestion } from "../../extensions/lib/newer-model.ts";
import { pinReleaseDates } from "./catalog-fixture.ts";

type ModelFactsRow = { releaseDate: string; toolCall?: false };

const model = (id: string, input = 1, output = 3, provider = "openrouter") =>
	({ provider, id, name: id, cost: { input, output, cacheRead: 0, cacheWrite: 0 }, api: "openai-completions" }) as Model<Api>;
const old = model("qwen/qwen3.6-27b", 0.32, 3.2);
const newer = model("qwen/qwen3.8-27b", 0.42, 3);
let facts: Record<string, ModelFactsRow>;
function date(m: Model<Api>, releaseDate: string, toolCall?: false) {
	facts[`${m.provider}/${m.id}`] = { releaseDate, ...(toolCall === false ? { toolCall } : {}) };
	pinReleaseDates(facts);
}
beforeEach(() => {
	facts = {};
	date(old, "2026-04-01");
	date(newer, "2026-08-01");
});

describe("modelLine", () => {
	it.each([
		["qwen/qwen3.6-27b", "qwen/qwen3.8-27b"],
		["deepseek/deepseek-chat-v3-0324", "deepseek/deepseek-chat-v3.1"],
		["gpt-5.6-luna", "gpt-6-luna"],
		["claude-opus-4-8-20251101", "claude-opus-5-5"],
		["qwen/qwen3.6-27b:batch", "qwen/qwen3.8-27b:free"],
		["gpt-5.6-luna-2026-07-09", "gpt-6-luna"],
	])("matches versions of %s and %s", (a, b) => {
		expect(modelLine(a)?.line).toBe(modelLine(b)?.line);
		expect(modelLine(a)).toBeDefined();
	});
	it.each(["qwen-plus", "qwen-plus-2025-07-28", "qwen-plus-20250728", "qwen-plus-0728", "mistral-large-2407", "mistral-large-2512", "model-27b"])("does not invent a version for %s", (id) => {
		expect(modelLine(id)).toBeUndefined();
	});
	it("keeps author, size, and model class distinct", () => {
		for (const id of ["qwen/qwen3.8-32b", "qwen/qwen3.8-plus", "other/qwen3.8-27b"]) {
			expect(modelLine(id)?.line).not.toBe(modelLine(old.id)?.line);
		}
	});
});

describe("newerModelSuggestion", () => {
	it("reproduces the Qwen upgrade despite its higher input price and tiny tier", () => {
		const suggestion = newerModelSuggestion([old, newer], old);
		expect(suggestion?.model).toBe(newer);
		expect(suggestion?.text).toBe("qwen/qwen3.8-27b is newer than qwen/qwen3.6-27b and costs about the same ($0.42/$3.00 vs $0.32/$3.20 per M tokens).");
		expect(suggestion?.fix).toBe("Switch with /model openrouter/qwen/qwen3.8-27b.");
	});
	it.each([
		[model("z-ai/glm-5.1"), model("z-ai/glm-5.3")],
		[model("gpt-5.6-luna", 0.2, 1, "openai"), model("gpt-6-luna", 0.1, 0.5, "openai")],
		[model("deepseek/deepseek-chat-v3-0324"), model("deepseek/deepseek-chat-v3.1")],
		[model("claude-opus-4-8", 5, 25, "anthropic"), model("claude-opus-5-5", 5, 25, "anthropic")],
	])("finds the same-line upgrade for %j", (current, candidate) => {
		date(current, "2026-01-01");
		date(candidate, "2026-08-01");
		expect(newerModelSuggestion([current, candidate], current)?.model).toBe(candidate);
	});
	it("describes a substantially cheaper upgrade as costing less", () => {
		const current = model("gpt-5.6-luna", 0.2, 1, "openai");
		const candidate = model("gpt-6-luna", 0.1, 0.5, "openai");
		date(current, "2026-01-01");
		date(candidate, "2026-08-01");
		expect(newerModelSuggestion([candidate], current)?.text).toContain("costs less ($0.10/$0.50 vs $0.20/$1.00");
	});
	it("preserves sub-cent prices in the notice", () => {
		const current = { ...old, cost: { ...old.cost, input: 0.001, output: 0.003 } };
		const candidate = { ...newer, cost: { ...newer.cost, input: 0.001, output: 0.003 } };
		expect(newerModelSuggestion([candidate], current)?.text).toContain("$0.001/$0.003 vs $0.001/$0.003");
	});
	it("requires availability and the same provider", () => {
		const elsewhere = { ...newer, provider: "qwen-token-plan" };
		date(elsewhere, "2026-08-01");
		expect(newerModelSuggestion([old, elsewhere], old)).toBeUndefined();
		expect(newerModelSuggestion([old], old)).toBeUndefined();
		expect(newerModelSuggestion([newer], undefined)).toBeUndefined();
	});
	it.each(["qwen/qwen3.8-32b", "qwen/qwen3.8-plus", "other/qwen3.8-27b"])("does not cross model lines into %s", (id) => {
		const candidate = model(id, 0.4, 3);
		date(candidate, "2026-08-01");
		expect(newerModelSuggestion([candidate], old)).toBeUndefined();
	});
	it("does not suggest a dated Qwen Plus alias as an upgrade", () => {
		const current = model("qwen/qwen-plus");
		const candidate = model("qwen/qwen-plus-2025-07-28");
		date(current, "2025-01-01");
		date(candidate, "2025-07-28");
		expect(newerModelSuggestion([candidate], current)).toBeUndefined();
	});
	it("does not treat calendar-named Mistral releases as numeric versions", () => {
		const current = model("mistralai/mistral-large-2407");
		const candidate = model("mistralai/mistral-large-2512");
		date(current, "2024-07-01");
		date(candidate, "2025-12-01");
		expect(newerModelSuggestion([candidate], current)).toBeUndefined();
	});
	it.each(["2026-03-01", "2026-04-01", "unknown", ""])("requires a strictly later known release date, not %s", (release) => {
		date(newer, release);
		expect(newerModelSuggestion([newer], old)).toBeUndefined();
	});
	it("skips either missing date", () => {
		pinReleaseDates({ [`${old.provider}/${old.id}`]: facts[`${old.provider}/${old.id}`] });
		expect(newerModelSuggestion([newer], old)).toBeUndefined();
		pinReleaseDates({ [`${newer.provider}/${newer.id}`]: facts[`${newer.provider}/${newer.id}`] });
		expect(newerModelSuggestion([newer], old)).toBeUndefined();
	});
	it("requires a higher version even for a later build", () => {
		for (const id of ["qwen/qwen3.5-27b", "qwen/qwen3.6-27b-20260901"]) {
			const candidate = model(id, 0.4, 3);
			date(candidate, "2026-09-01");
			expect(newerModelSuggestion([candidate], old)).toBeUndefined();
		}
	});
	it("allows exactly ten percent more blended cost but not more", () => {
		const current = { ...old, cost: { ...old.cost, input: 1, output: 1 } };
		const candidate = { ...newer, cost: { ...newer.cost, input: 1.1, output: 1.1 } };
		expect(newerModelSuggestion([candidate], current)?.model).toBe(candidate);
		expect(newerModelSuggestion([{ ...candidate, cost: { ...candidate.cost, output: 1.101 } }], current)).toBeUndefined();
	});
	it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("skips missing or invalid prices (%s) on either side", (value) => {
		for (const field of ["input", "output"] as const) {
			const bad = (m: Model<Api>) => ({ ...m, cost: { ...m.cost, [field]: value } }) as Model<Api>;
			expect(newerModelSuggestion([bad(newer)], old)).toBeUndefined();
			expect(newerModelSuggestion([newer], bad(old))).toBeUndefined();
		}
	});
	it("skips a missing cost object", () => {
		expect(newerModelSuggestion([{ ...newer, cost: undefined } as unknown as Model<Api>], old)).toBeUndefined();
	});
	it.each([":batch", ":free", ":online", ":thinking", ":nitro", "-exp", "-experimental", "-latest"])("does not recommend the variant %s", (suffix) => {
		const candidate = { ...newer, id: newer.id + suffix };
		date(candidate, "2026-08-01");
		expect(newerModelSuggestion([candidate], old)).toBeUndefined();
	});
	it("does not recommend redirect aliases", () => {
		const candidate = { ...newer, id: `~${newer.id}` };
		date(candidate, "2026-08-01");
		expect(newerModelSuggestion([candidate], old)).toBeUndefined();
	});
	it("can suggest an ordinary upgrade from a priced route variant", () => {
		expect(newerModelSuggestion([newer], { ...old, id: `${old.id}:nitro` })?.model).toBe(newer);
	});
	it("rejects models known to lack tool calls", () => {
		date(newer, "2026-08-01", false);
		expect(newerModelSuggestion([newer], old)).toBeUndefined();
	});
	it("rejects a candidate over two years behind its vendor's newest model", () => {
		date(model("qwen/qwen4-max"), "2028-09-01");
		expect(newerModelSuggestion([newer], old)).toBeUndefined();
	});
	it("chooses highest version, then later release, then lower blend without mutating the catalog", () => {
		const v310 = model("qwen/qwen3.10-27b", 0.4, 3);
		const later = model("qwen/qwen3.10-27b-20260902", 0.4, 3);
		const cheaper = model("qwen/qwen3.10-27b-0902", 0.3, 3);
		date(v310, "2026-08-02");
		date(later, "2026-09-02");
		date(cheaper, "2026-09-02");
		const catalog = [newer, v310, later, cheaper];
		expect(newerModelSuggestion(catalog, old)?.model).toBe(cheaper);
		expect(newerModelSuggestion(catalog.slice(0, 3), old)?.model).toBe(later);
		expect(newerModelSuggestion(catalog.slice(0, 2), old)?.model).toBe(v310);
		expect(catalog).toEqual([newer, v310, later, cheaper]);
	});
});
