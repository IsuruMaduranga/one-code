import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { thinkingLevelsFor } from "../../extensions/lib/models/thinking-levels.ts";
import { THINKING_LEVEL_NAMES } from "../../extensions/lib/profile/thinking-defaults.ts";

let runtime: ModelRuntime;
beforeAll(async () => {
	runtime = await ModelRuntime.create({
		credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } as never,
		modelsPath: null,
		refreshOnCreate: false,
	});
});

describe("thinkingLevelsFor", () => {
	it("a model with a low: reaches it, and low stays low", () => {
		const haiku = runtime.getModel("anthropic", "claude-haiku-4-5")!;
		const levels = thinkingLevelsFor(haiku);
		expect(levels.supported).toContain("low");
		expect(levels.settle("low")).toBe("low");
		expect(levels.settle("high")).toBe("high");
	});

	it("a model with no low: leaves it out, and low settles on the level pi runs", () => {
		const flash = runtime.getModel("openrouter", "deepseek/deepseek-v4-flash")!;
		const levels = thinkingLevelsFor(flash);
		expect(levels.supported).not.toContain("low");
		expect(levels.settle("low")).toBe("high");
		// A level the model reaches is never moved, so a listener sees a clamp as `settle(wanted) !== wanted`.
		for (const level of levels.supported) expect(levels.settle(level)).toBe(level);
	});

	it("settles every level onto one the model supports", () => {
		for (const model of [runtime.getModel("anthropic", "claude-haiku-4-5")!, runtime.getModel("openrouter", "deepseek/deepseek-v4.1-flash")!]) {
			const levels = thinkingLevelsFor(model);
			for (const level of THINKING_LEVEL_NAMES) expect(levels.supported).toContain(levels.settle(level));
		}
	});

	it("with no model: the whole ladder, and nothing is fitted", () => {
		const levels = thinkingLevelsFor(undefined);
		expect(levels.supported).toEqual([...THINKING_LEVEL_NAMES]);
		for (const level of THINKING_LEVEL_NAMES) expect(levels.settle(level)).toBe(level);
	});
});
