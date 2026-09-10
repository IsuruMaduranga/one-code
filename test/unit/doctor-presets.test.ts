import { describe, expect, it } from "vitest";
import { computePresets, describePresetChanges, findPreset, presetPool, presetsSection } from "../../extensions/doctor/presets.ts";

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
		expect(byName.balanced.subagents.model.id).toBe("claude-haiku-4-5");
		expect(byName.balanced.classifier?.id).toBe("claude-sonnet-5"); // workhorse floor: nothing cheaper qualifies
		expect(byName.quality.main.id).toBe("claude-opus-5");
		expect(byName.quality.subagents.model.id).toBe("claude-opus-5");
		expect(byName.quality.classifier?.id).toBe("claude-sonnet-5");
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
