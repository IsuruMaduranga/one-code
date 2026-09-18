import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveForContainment } from "../../extensions/auto-mode/paths.ts";
import { comparablePath } from "../../extensions/lib/paths.ts";
import { scratchpadDir, scratchpadPromptSection, sessionScratchpadDir } from "../../extensions/lib/scratchpad.ts";
import { isInsideDir } from "../../extensions/permissions/matcher.ts";

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

describe("sessionScratchpadDir", () => {
	it("is spelled in the temp root's resolved form, so a resolved write inside it is recognised", () => {
		// macOS: /tmp → /private/tmp; Windows: %TEMP% through its 8.3 short names
		// (`RUNNER~1` on the CI runner). The permission check compares the
		// realpath'd subject against this dir with no further resolution.
		const dir = sessionScratchpadDir(process.cwd(), "session-1");
		const resolved = resolveForContainment(join(dir, "notes.md"));
		expect(resolved, `${resolved} vs ${dir}`).toBe(comparablePath(join(dir, "notes.md")));
		expect(isInsideDir(resolved!, dir, process.cwd())).toBe(true);
	});
});
