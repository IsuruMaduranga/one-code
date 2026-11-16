import { describe, expect, it } from "vitest";
import { collectModelFacts, modelsSection } from "../../extensions/commands/doctor/models.ts";
import { pinCatalog } from "./catalog-fixture.ts";
import { tempHome } from "./helpers/temp-home.ts";

const model = (provider: string, id: string, input: number) =>
	({ provider, id, name: id, api: "anthropic-messages", cost: { input, output: input * 5 }, contextWindow: 200_000 }) as any;

describe("doctor: the classifier fallback", () => {
	it("names why the session model screens itself when the pairing table kept it, though no notice announces it", () => {
		const { home } = tempHome("doctor-classifier-");
		pinCatalog([
			{ id: "anthropic/claude-opus-5-5", released: "2026-09-22", price: [4, 20] },
			{ id: "anthropic/claude-haiku-5-5", released: "2026-10-07", price: [0.1, 0.5] },
		]);
		const session = model("anthropic", "claude-haiku-5-5", 0.1);
		const facts = collectModelFacts([session, model("anthropic", "claude-opus-5-5", 4)], { model: session, modelSource: "session" }, home, {});
		expect(facts.classifier.notices).toEqual([]);
		expect(facts.classifier.fallback?.reason).toBe("paired-session");
		const text = modelsSection(facts, { model: session, modelSource: "session" }, []).lines.map((line) => line.text);
		expect(text).toContain(facts.classifier.fallback?.text);
	});
});
