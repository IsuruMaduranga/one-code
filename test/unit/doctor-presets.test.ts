import { describe, expect, it } from "vitest";
import { computePresets, describePresetChanges, findPreset, presetPool, presetsSection } from "../../extensions/doctor/presets.ts";
import { setModelFactsForTest } from "../../extensions/lib/model-facts.ts";

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
		expect(byName.balanced.subagents.model.id).toBe("claude-sonnet-5"); // workhorse floor (shared with the classifier): nothing cheaper qualifies
		expect(byName.balanced.classifier?.id).toBe("claude-sonnet-5");
		expect(byName.quality.main.id).toBe("claude-opus-5");
		expect(byName.quality.subagents.model.id).toBe("claude-opus-5");
		expect(byName.quality.classifier?.id).toBe("claude-sonnet-5");
	});

	it("picks the current-generation DeepSeek Flash as the economical main on OpenRouter, not the boundary-priced R1", () => {
		// pi's bundled OpenRouter catalog rows and prices, 2026-09-10 — the shape that
		// made /doctor preset balanced name deepseek-r1-0528 (docs/features/tiering/plan.md).
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
		// Snapshots (-0528, -0731, -0813) collapse onto their undated alias; batch
		// variants, the moving `~…-latest` redirect alias and other vendors are out.
		const pool = presetPool(catalog, session).map((m) => m.id);
		expect(pool).toEqual([
			"deepseek/deepseek-chat",
			"deepseek/deepseek-chat-v3.1",
			"deepseek/deepseek-r1",
			"deepseek/deepseek-v3.2",
			"deepseek/deepseek-v4-flash",
			"deepseek/deepseek-v4-flash-vision-exp",
			"deepseek/deepseek-v4-pro",
		]);
		const { presets } = computePresets(catalog, session);
		const byName = Object.fromEntries(presets.map((p) => [p.name, p]));
		expect(byName.balanced.main.id).toBe("deepseek/deepseek-v4-pro");
		expect(byName.balanced.subagents.model.id).toBe("deepseek/deepseek-v4-pro"); // workhorse floor: Pro is the only workhorse row (Flash qualifies only by measured score)
		expect(byName.balanced.classifier?.id).toBe("deepseek/deepseek-v4-pro");
		expect(byName.economical.main.id).toBe("deepseek/deepseek-v4-flash");
		expect(byName.quality.main.id).toBe("deepseek/deepseek-v4-pro"); // the undated alias, not the pricier -0813 snapshot
	});

	it("never recommends a prior-generation or tool-less model as a preset's main", () => {
		setModelFactsForTest({
			"openai/gpt-6-astra": { releaseDate: "2026-09-04" },
			"openai/gpt-5-pro": { releaseDate: "2025-08-07" }, // a year behind → prior generation
			"openai/gpt-5.6-sol": { releaseDate: "2026-07-09" },
			"openai/gpt-5.6-luna": { releaseDate: "2026-07-09" },
			"openai/text-only": { releaseDate: "2026-08-01", toolCall: false },
		});
		const oa = (id: string, input: number) => model("openai", id, input, "openai-responses");
		const catalog = [oa("gpt-6-astra", 5), oa("gpt-5-pro", 15), oa("gpt-5.6-sol", 4.5), oa("gpt-5.6-luna", 0.2), oa("text-only", 0.05)];
		expect(presetPool(catalog, catalog[2]).map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"]);
		const { presets } = computePresets(catalog, catalog[2]);
		expect(presets.find((p) => p.name === "quality")?.main.id).toBe("gpt-6-astra"); // not the pricier, prior-generation gpt-5-pro
		expect(presets.find((p) => p.name === "economical")?.main.id).toBe("gpt-5.6-luna"); // not the tool-less row
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

	it("renders one row per preset marking the current main model, and spells the undo path", () => {
		const result = computePresets(anthropic, anthropic[1]);
		const section = presetsSection(result, anthropic[1]);
		expect(section.subtitle).toContain("within anthropic");
		const balanced = section.lines.find((l) => l.text.startsWith("balanced:"));
		expect(balanced?.text).toContain("← current main model");
		expect(balanced?.level).toBe("ok");
		const changes = describePresetChanges(result.presets.find((p) => p.name === "quality")!);
		expect(changes[0]).toContain("undo: /model");
		expect(changes[1]).toContain("/subagent clear");
		expect(changes[2]).toContain("/auto-mode model");
	});
});
