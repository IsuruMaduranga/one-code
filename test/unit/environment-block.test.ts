/**
 * The environment block and the model line: the facts, model name and
 * knowledge cutoff the base hands the profile's text (lib/environment-block.ts).
 * One Code's wording of them: profile/test/environment-block-wording.test.ts.
 */
import { describe, expect, it } from "vitest";
import { claudeDisplayName, environmentBlock, modelLine } from "../../extensions/lib/environment-block.ts";
import { requireText } from "../../extensions/lib/profile.ts";

const context = requireText("context");

describe("environmentBlock", () => {
	it("is the profile's block for the facts given", () => {
		const facts = { cwd: "/p", isGitRepo: true, platform: "darwin", shell: "zsh", osVersion: "Darwin 24.2.0", scratchpadDir: "/private/tmp/agent-501/-p/s/scratchpad" };
		expect(environmentBlock(facts)).toBe(context.environment(facts));
	});

	it("passes no scratchpad when no private scratchpad could be made", () => {
		const facts = { cwd: "/p", isGitRepo: false, platform: "linux", shell: "bash", osVersion: "Linux 6" };
		expect(environmentBlock(facts)).toBe(context.environment(facts));
	});
});

describe("modelLine", () => {
	it("names a Claude model by family and version, with its cutoff", () => {
		expect(modelLine({ id: "claude-opus-5-5", name: "Claude Opus 5.5" })).toBe(context.modelLine({ name: "Opus 5.5", id: "claude-opus-5-5", cutoff: "June 2026" }));
		expect(modelLine({ id: "claude-haiku-4-5-20251001" })).toBe(context.modelLine({ name: "Haiku 4.5", id: "claude-haiku-4-5-20251001", cutoff: "February 2025" }));
		expect(modelLine({ id: "claude-haiku-5-5" })).toBe(context.modelLine({ name: "Haiku 5.5", id: "claude-haiku-5-5", cutoff: "June 2026" }));
		expect(modelLine({ id: "claude-opus-5" })).toBe(context.modelLine({ name: "Opus 5", id: "claude-opus-5", cutoff: "May 2026" }));
	});

	it("reads gateway and dotted spellings, and passes no cutoff when none is known", () => {
		expect(claudeDisplayName("anthropic/claude-sonnet-5.5")).toBe("Sonnet 5.5");
		expect(claudeDisplayName("claude-opus-4-8-20251101")).toBe("Opus 4.8");
		expect(modelLine({ id: "claude-fable-5" })).toBe(context.modelLine({ name: "Fable 5", id: "claude-fable-5" }));
	});

	it("gives any other model the catalog name, else its id, and no cutoff", () => {
		expect(modelLine({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })).toBe(context.modelLine({ name: "DeepSeek V4.1 Flash", id: "deepseek-v4.1-flash" }));
		expect(modelLine({ id: "gpt-6-sol", name: "" })).toBe(context.modelLine({ name: "gpt-6-sol", id: "gpt-6-sol" }));
	});
});
