import { describe, expect, it } from "vitest";
import { applyDefaultModel } from "../../extensions/model-default/index.ts";

describe("applyDefaultModel", () => {
	it("sets the default model while preserving every other key", () => {
		const file = { theme: "onecode", defaultProvider: "anthropic", defaultModel: "claude-opus-5", nested: { a: 1 } };
		expect(applyDefaultModel(file, "openrouter", "qwen/qwen3.6-27b")).toEqual({
			theme: "onecode",
			defaultProvider: "openrouter",
			defaultModel: "qwen/qwen3.6-27b",
			nested: { a: 1 },
		});
		// Input is not mutated.
		expect(file.defaultProvider).toBe("anthropic");
	});

	it("works on an empty settings object", () => {
		expect(applyDefaultModel({}, "openai-codex", "gpt-5.6-sol")).toEqual({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-sol",
		});
	});
});
