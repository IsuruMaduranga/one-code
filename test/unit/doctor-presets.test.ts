import { beforeEach, describe, expect, it } from "vitest";
import { computePresets, describePresetChanges, findPreset, presetPool, presetsSection } from "../../extensions/doctor/presets.ts";
import { pinCatalog, pinReleaseDates } from "./catalog-fixture.ts";

const model = (provider: string, id: string, input?: number, api = "anthropic-messages") =>
	({ provider, id, name: id, api, cost: input === undefined ? undefined : { input, output: input * 5 }, contextWindow: 200_000 }) as any;

const anthropic = [
	model("anthropic", "claude-opus-5", 5),
	model("anthropic", "claude-sonnet-5", 3),
	model("anthropic", "claude-haiku-4-5", 1),
	model("anthropic", "claude-haiku-4-5-20251001", 1),
];
const openai = [model("openai", "gpt-5.1", 1.25, "openai-responses"), model("openai", "gpt-5-mini", 0.25, "openai-responses"), model("openai", "gpt-5-nano", 0.05, "openai-responses")];

describe("computePresets", () => {
	beforeEach(() =>
		pinCatalog([
			{ id: "anthropic/claude-opus-5", released: "2026-07-24", price: [5, 25] },
			{ id: "anthropic/claude-sonnet-5", released: "2026-06-29", price: [3, 15] },
			{ id: "anthropic/claude-fable-5", released: "2026-06-07", price: [10, 50] },
			{ id: "anthropic/claude-haiku-4-5", released: "2025-10-15", price: [1, 5], servedAs: ["anthropic/claude-haiku-4-5-20251001"] },
			{ id: "openai/gpt-5.1", released: "2026-09-01", price: [1.25, 10] },
			{ id: "openai/gpt-5.2", released: "2026-09-01", price: [1.75, 14] },
			{ id: "openai/gpt-5-mini", released: "2026-09-01", price: [0.25, 2] },
			{ id: "openai/gpt-5-nano", released: "2026-09-01", price: [0.05, 0.4] },
		]),
	);

	it("stays within the session's provider and collapses dated duplicates", () => {
		const pool = presetPool([...anthropic, ...openai], anthropic[0]);
		expect(pool.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
	});

	it("picks economical / balanced / quality mains by tier and price, with the resolvers' secondary picks", () => {
		const { presets } = computePresets([...anthropic, ...openai], anthropic[1]);
		const byName = Object.fromEntries(presets.map((p) => [p.name, p]));
		expect(byName.economical.main.id).toBe("claude-haiku-4-5");
		expect(byName.economical.subagents).toMatchObject({ setting: "inherit" });
		expect(byName.economical.classifier?.id).toBe("claude-haiku-4-5");
		expect(byName.balanced.main.id).toBe("claude-sonnet-5");
		expect(byName.balanced.current).toBe(true);
		expect(byName.balanced.subagents).toMatchObject({ setting: "auto" });
		expect(byName.balanced.subagents.model.id).toBe("claude-sonnet-5"); // Nothing cheaper is in its tier.
		expect(byName.balanced.classifier?.id).toBe("claude-sonnet-5");
		expect(byName.quality.main.id).toBe("claude-opus-5");
		expect(byName.quality.subagents.model.id).toBe("claude-opus-5");
		expect(byName.quality.classifier?.id).toBe("claude-opus-5"); // No cheaper frontier model here.
	});

	it("keeps superseded, variant and redirect rows out of a gateway's pool", () => {
		pinCatalog([
			{ id: "deepseek/deepseek-v4-pro", released: "2026-08-12", price: [0.435, 0.87], params: 1.6e12, servedAs: ["openrouter/deepseek/deepseek-v4-pro", "openrouter/deepseek/deepseek-v4-pro-0813"] },
			{ id: "deepseek/deepseek-v4-flash", released: "2026-07-31", price: [0.2, 0.4], params: 284e9, servedAs: ["openrouter/deepseek/deepseek-v4-flash", "openrouter/deepseek/deepseek-v4-flash-0731"] },
			{ id: "deepseek/deepseek-v4-flash-vision-exp", released: "2026-08-21", price: [0.4, 0.8], params: 305e9, servedAs: ["openrouter/deepseek/deepseek-v4-flash-vision-exp"] },
			{ id: "deepseek/deepseek-v3.2", released: "2025-12-01", price: [0.28, 0.42], params: 685e9, servedAs: ["openrouter/deepseek/deepseek-v3.2", "openrouter/deepseek/deepseek-chat"] },
			{ id: "deepseek/deepseek-v3.1", released: "2025-08-21", price: [0.27, 1.1], params: 685e9, servedAs: ["openrouter/deepseek/deepseek-chat-v3.1"] },
			{ id: "deepseek/deepseek-r1", released: "2025-05-28", price: [0.5, 2.15], params: 671e9, servedAs: ["openrouter/deepseek/deepseek-r1", "openrouter/deepseek/deepseek-r1-0528"] },
		]);
		const or = (id: string, input: number) => model("openrouter", `deepseek/${id}`, input, "openai-completions");
		const catalog = [
			or("deepseek-chat", 0.32),
			or("deepseek-chat-v3.1", 0.55),
			or("deepseek-r1", 0.7),
			or("deepseek-r1-0528", 0.5),
			or("deepseek-v3.2", 0.269),
			or("deepseek-v4-flash", 0.08526),
			or("deepseek-v4-flash-0731", 0.065),
			or("deepseek-v4-flash-0731:batch", 0.14),
			or("deepseek-v4-flash-vision-exp", 0.22),
			or("deepseek-v4-pro", 0.890358),
			or("deepseek-v4-pro-0813", 1.12068),
			or("deepseek-v4-pro-0813:batch", 1.32),
			model("openrouter", "~deepseek/deepseek-v4-flash-latest", 0.04998, "openai-completions"),
			model("openrouter", "openai/gpt-5-mini", 0.25, "openai-completions"),
		];
		const session = catalog.find((m) => m.id === "deepseek/deepseek-v4-pro")!;
		// V3.2 (and the deepseek-chat alias serving it) is superseded by V4 Flash,
		// V3.1 by V3.2; snapshots collapse onto their undated alias; batch variants,
		// the moving `~…-latest` alias and other vendors are out.
		expect(presetPool(catalog, session).map((m) => m.id)).toEqual([
			"deepseek/deepseek-r1",
			"deepseek/deepseek-v4-flash",
			"deepseek/deepseek-v4-flash-vision-exp",
			"deepseek/deepseek-v4-pro",
		]);
		const { presets } = computePresets(catalog, session);
		const byName = Object.fromEntries(presets.map((p) => [p.name, p]));
		expect(byName.balanced.main.id).toBe("deepseek/deepseek-v4-pro");
		expect(byName.balanced.subagents.model.id).toBe("deepseek/deepseek-v4-pro"); // Pro is the only workhorse row
		expect(byName.balanced.classifier?.id).toBe("deepseek/deepseek-v4-pro");
		expect(byName.economical.main.id).toBe("deepseek/deepseek-v4-flash");
		expect(byName.quality.main.id).toBe("deepseek/deepseek-v4-pro"); // the undated alias, not the pricier -0813 snapshot
	});

	it("never recommends a legacy or tool-less model as a preset's main", () => {
		pinReleaseDates({
			"openai/gpt-6-astra": { releaseDate: "2026-09-04" },
			"openai/gpt-5-pro": { releaseDate: "2024-08-07" }, // over two years behind → legacy
			"openai/gpt-5.6-sol": { releaseDate: "2026-07-09" },
			"openai/gpt-5.6-luna": { releaseDate: "2026-07-09" },
			"openai/text-only": { releaseDate: "2026-08-01", toolCall: false },
		});
		const oa = (id: string, input: number) => model("openai", id, input, "openai-responses");
		const catalog = [oa("gpt-6-astra", 5), oa("gpt-5-pro", 15), oa("gpt-5.6-sol", 4.5), oa("gpt-5.6-luna", 0.2), oa("text-only", 0.05)];
		expect(presetPool(catalog, catalog[2]).map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"]);
		const { presets } = computePresets(catalog, catalog[2]);
		expect(presets.find((p) => p.name === "quality")?.main.id).toBe("gpt-6-astra"); // not the pricier, legacy gpt-5-pro
		expect(presets.find((p) => p.name === "economical")?.main.id).toBe("gpt-5.6-luna"); // not the tool-less row
	});

	it("previews a below-frontier main's classifier as the cheaper model in its tier", () => {
		pinCatalog([
			{ id: "openai/gpt-5.6-sol", released: "2026-07-09", price: [5, 20] },
			{ id: "openai/gpt-5.6-terra", released: "2026-07-09", price: [2, 8] },
			{ id: "openai/gpt-5.6-max", released: "2026-07-09", price: [10, 40] },
		]);
		const main = model("openai", "gpt-5.6-sol", 5, "openai-responses");
		const cheaper = model("openai", "gpt-5.6-terra", 2, "openai-responses");
		const result = computePresets([main, cheaper], main);
		const quality = result.presets.find((preset) => preset.name === "quality")!;
		expect(quality.main).toBe(main);
		expect(quality.classifier).toBe(cheaper);
		expect(describePresetChanges(quality)[2]).toBe("auto-mode classifier → automatic (picks openai/gpt-5.6-terra) (undo: /auto-mode model)");
		const text = presetsSection(result, main).lines.map((line) => line.text).join("\n");
		expect(text).toContain("the cheapest model in its tier or above, never dearer than the main model");
	});

	it("never lands the economical preset on a tiny model while a capable one exists", () => {
		const { presets } = computePresets(openai, openai[0]);
		const economical = presets.find((p) => p.name === "economical")!;
		expect(economical.main.id).toBe("gpt-5-mini");
		const quality = presets.find((p) => p.name === "quality")!;
		expect(quality.main.id).toBe("gpt-5.1");
		expect(quality.note).toContain("no frontier-tier model");
	});

	it("explains itself when there is no model or no priced model", () => {
		expect(computePresets(anthropic, undefined)).toEqual({ presets: [], unavailable: "no-model" });
		const unpriced = model("ollama", "local", undefined, "openai-completions");
		expect(computePresets([unpriced], unpriced)).toEqual({ presets: [], unavailable: "no-priced-models" });
		expect(presetsSection(computePresets(anthropic, undefined), undefined).lines[0].text).toContain("/login");
	});

	it("accepts aliases for preset names", () => {
		const { presets } = computePresets(anthropic, anthropic[1]);
		expect(findPreset(presets, "maximum quality")?.name).toBe("quality");
		expect(findPreset(presets, "cheap")?.name).toBe("economical");
		expect(findPreset(presets, "nope")).toBeUndefined();
	});

	it("renders one row per preset marking the current main model and keeps the classifier automatic", () => {
		const result = computePresets(anthropic, anthropic[1]);
		const section = presetsSection(result, anthropic[1]);
		expect(section.subtitle).toContain("within anthropic");
		const balanced = section.lines.find((l) => l.text.startsWith("balanced:"));
		expect(balanced?.text).toContain("← current main model");
		expect(balanced?.level).toBe("ok");
		const changes = describePresetChanges(result.presets.find((p) => p.name === "quality")!);
		expect(changes[0]).toContain("undo: /model");
		expect(changes[1]).toContain("/subagent clear");
		expect(changes[2]).toContain("classifier → automatic");
		expect(changes[2]).toContain("undo: /auto-mode model");
	});
});
