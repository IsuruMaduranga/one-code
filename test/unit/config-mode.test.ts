import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeSourcesOn, configMode, readConfigMode, resetConfigModeForTest, savedConfigMode } from "../../extensions/lib/config-mode.ts";
import { memoryDir } from "../../extensions/lib/memory.ts";

function homeWith(settings: string | undefined): string {
	const home = mkdtempSync(join(tmpdir(), "config-mode-"));
	if (settings !== undefined) {
		mkdirSync(join(home, ".onecode"), { recursive: true });
		writeFileSync(join(home, ".onecode", "settings.json"), settings);
	}
	return home;
}

describe("readConfigMode", () => {
	it("defaults to claude-compatible with no settings file", () => {
		expect(readConfigMode(homeWith(undefined), {})).toBe("claude-compatible");
	});

	it("reads configMode from One Code's user settings", () => {
		expect(readConfigMode(homeWith(JSON.stringify({ configMode: "independent" })), {})).toBe("independent");
	});

	it("reads a malformed file or an unknown value as the default", () => {
		expect(readConfigMode(homeWith("{not json"), {})).toBe("claude-compatible");
		expect(readConfigMode(homeWith(JSON.stringify({ configMode: "strict" })), {})).toBe("claude-compatible");
	});

	it("lets ONECODE_CONFIG_MODE override the file, ignoring an unknown value", () => {
		const home = homeWith(JSON.stringify({ configMode: "independent" }));
		expect(readConfigMode(home, { ONECODE_CONFIG_MODE: "claude-compatible" })).toBe("claude-compatible");
		expect(readConfigMode(home, { ONECODE_CONFIG_MODE: "bogus" })).toBe("independent");
		expect(savedConfigMode(home, { ONECODE_CONFIG_MODE: "claude-compatible" })).toBe("independent");
	});

	it("follows ONECODE_STATE_DIR", () => {
		const state = join(homeWith(undefined), "state");
		mkdirSync(state);
		writeFileSync(join(state, "settings.json"), JSON.stringify({ configMode: "independent" }));
		expect(readConfigMode(homeWith(undefined), { ONECODE_STATE_DIR: state })).toBe("independent");
	});
});

describe("configMode", () => {
	it("is pinned for the process once read", () => {
		resetConfigModeForTest("independent");
		expect(configMode()).toBe("independent");
		expect(claudeSourcesOn()).toBe(false);
		resetConfigModeForTest("claude-compatible");
		expect(claudeSourcesOn()).toBe(true);
	});
});

describe("memoryDir by mode", () => {
	it("moves auto-memory under ~/.onecode in independent mode", () => {
		const home = join("/", "Users", "u");
		expect(memoryDir(home, "/tmp/project", "claude-compatible")).toBe(join(home, ".claude", "projects", "-tmp-project", "memory"));
		expect(memoryDir(home, "/tmp/project", "independent")).toBe(join(home, ".onecode", "projects", "-tmp-project", "memory"));
	});
});
