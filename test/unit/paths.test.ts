import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeConfigDir, oneCodeStateDir } from "../../extensions/lib/paths.ts";

describe("paths", () => {
	it("defaults to ~/.claude and ~/.one-code", () => {
		expect(claudeConfigDir({})).toBe(join(homedir(), ".claude"));
		expect(oneCodeStateDir({})).toBe(join(homedir(), ".one-code"));
	});

	it("honours the env overrides", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/claude" })).toBe("/custom/claude");
		expect(oneCodeStateDir({ ONE_CODE_STATE_DIR: "/custom/one-code" })).toBe("/custom/one-code");
	});

	it("ignores empty overrides", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" })).toBe(join(homedir(), ".claude"));
		expect(oneCodeStateDir({ ONE_CODE_STATE_DIR: "" })).toBe(join(homedir(), ".one-code"));
	});
});
