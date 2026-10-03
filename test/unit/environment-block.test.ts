import { describe, expect, it } from "vitest";
import { claudeDisplayName, environmentBlock, modelLine } from "../../extensions/lib/environment-block.ts";

describe("environmentBlock", () => {
	it("is Claude Code's block byte for byte", () => {
		const scratchpad = "/private/tmp/onecode-501/-p/s/scratchpad";
		expect(environmentBlock({ cwd: "/p", isGitRepo: true, platform: "darwin", shell: "zsh", osVersion: "Darwin 24.2.0", scratchpadDir: scratchpad })).toBe(
			[
				"# Environment",
				"You have been invoked in the following environment: ",
				" - Primary working directory: /p",
				" - Is a git repository: true",
				" - Platform: darwin",
				" - Shell: zsh",
				" - OS Version: Darwin 24.2.0",
				` - Scratchpad directory: ${scratchpad} — always use it for temporary files (intermediate results, scripts, outputs that don't belong in the project) instead of \`/tmp\` or other system temp directories; it is session-specific, isolated from the project, and can generally be used without permission prompts. Only use \`/tmp\` if the user explicitly asks.`,
			].join("\n"),
		);
	});

	it("drops the scratchpad line when no private scratchpad could be made", () => {
		const block = environmentBlock({ cwd: "/p", isGitRepo: false, platform: "linux", shell: "bash", osVersion: "Linux 6" });
		expect(block.endsWith(" - OS Version: Linux 6")).toBe(true);
		expect(block).toContain(" - Is a git repository: false");
	});
});

describe("modelLine", () => {
	it("names a Claude model as Claude Code does, with its cutoff", () => {
		expect(modelLine({ id: "claude-opus-5-5", name: "Claude Opus 5.5" })).toBe(
			"You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.",
		);
		expect(modelLine({ id: "claude-haiku-4-5-20251001" })).toBe(
			"You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5-20251001. Assistant knowledge cutoff is February 2025.",
		);
		expect(modelLine({ id: "claude-opus-5" })).toContain("named Opus 5. The exact model ID is claude-opus-5. Assistant knowledge cutoff is May 2026.");
	});

	it("reads gateway and dotted spellings, and leaves the cutoff out when Claude Code states none", () => {
		expect(claudeDisplayName("anthropic/claude-sonnet-5.5")).toBe("Sonnet 5.5");
		expect(claudeDisplayName("claude-opus-4-8-20251101")).toBe("Opus 4.8");
		expect(modelLine({ id: "claude-fable-5" })).toBe("You are powered by the model named Fable 5. The exact model ID is claude-fable-5.");
	});

	it("gives any other model the catalog name and no cutoff", () => {
		expect(modelLine({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })).toBe(
			"You are powered by the model named DeepSeek V4.1 Flash. The exact model ID is deepseek-v4.1-flash.",
		);
		expect(modelLine({ id: "gpt-6-sol", name: "" })).toBe("You are powered by the model named gpt-6-sol. The exact model ID is gpt-6-sol.");
	});
});
