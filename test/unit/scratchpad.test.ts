import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchpadDir, scratchpadPromptSection } from "../../extensions/lib/scratchpad.ts";

describe("scratchpadDir", () => {
	it("builds Claude Code's path shape under a One Code-named owner dir", () => {
		expect(scratchpadDir("/private/tmp", 501, "/Users/u/ml/proj", "abc-123")).toBe(
			join("/private/tmp", "onecode-501", "-Users-u-ml-proj", "abc-123", "scratchpad"),
		);
	});

	it("drops the uid suffix where the platform has none", () => {
		expect(scratchpadDir("/tmp", undefined, "/home/u/proj", "s1")).toBe(join("/tmp", "onecode", "-home-u-proj", "s1", "scratchpad"));
	});
});

describe("scratchpadPromptSection", () => {
	it("carries Claude Code's wording and the concrete path", () => {
		const section = scratchpadPromptSection("/private/tmp/onecode-501/-p/s/scratchpad");
		expect(section).toContain("# Scratchpad Directory");
		expect(section).toContain("`/private/tmp/onecode-501/-p/s/scratchpad`");
		expect(section).toContain("instead of `/tmp`");
		expect(section).toContain("Only use `/tmp` if the user explicitly requests it.");
		expect(section).toContain("without permission prompts");
	});
});
