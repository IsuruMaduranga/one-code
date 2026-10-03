/**
 * Every module that names a Claude Code location must have been checked
 * against independent mode (lib/config-mode.ts): it either reads the location
 * only in Claude-compatible mode, or keeps it on purpose in both. A new reader
 * fails here until it is added to the list below with its reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "extensions");

/** Spellings of a Claude Code location in our source. */
const CLAUDE_LOCATION =
	/claudeUserDir\(|claudeConfigDir\(|claudeJsonPath\(|claudeUserSettingsPath\(|settingsPaths\(|managedSettingsPaths\(|["'`/]\.claude["'`/]|["'`]CLAUDE(\.local)?\.md["'`]/;

/** Each file, and how it treats independent mode. */
const CHECKED: Record<string, string> = {
	"lib/paths.ts": "defines the helpers",
	"lib/config-mode.ts": "the mode itself",
	"lib/claude-settings.ts": "readers gate on claudeSourcesOn; managed paths are shared",
	"lib/claude-context.ts": "the instruction rule drops every Claude Code file under agents-md",
	"lib/skill-scan.ts": "Claude Code skill folders only in compatible mode; commands via the config dirs",
	"lib/plugins.ts": "readClaudePlugins is false in independent mode",
	"lib/permission-gate.ts": "protection: ~/.claude stays protected and its secrets stay secret in both modes",
	"permissions/protected-paths.ts": "protection: .claude stays protected in both modes",
	"permissions/index.ts": ".claude.json flag and the ~/.claude allow warning gated",
	"auto-mode/config.ts": "autoModeSettingsPaths reads One Code's file only in independent mode",
	"auto-mode/safety-floor.ts": "protection: gate-control files stay on the floor in both modes",
	"auto-mode/instructions.ts": "the classifier reads the union in compatible mode, AGENTS.md only in independent",
	"auto-mode/setup-run.ts": "AGENTS.md and ONECODE.md in independent mode",
	"claude-compat/index.ts": "Claude Code skill and command folders only in compatible mode",
	"claude-context/index.ts": "passes the instruction rule",
	"file-tracker/index.ts": "passes the instruction rule",
	"memory/index.ts": "the picker's entries follow the instruction rule",
	"memory/entries.ts": "independent rows offer ONECODE.md and AGENTS.md",
	"hooks/settings.ts": "hookSettingsPaths reads One Code's files only in independent mode",
	"hooks/index.ts": "passes Claude Code's dir to the mode-aware loader",
	"mcp/config.ts": "configPaths is empty in independent mode",
	"mcp/index.ts": "labels only; the source list is mode-aware",
	"mcp/trust.ts": "reads One Code's files in independent mode",
	"doctor/compat.ts": "reports what each source holds; the mode line says what is read",
	"subagents/default-model.ts": "reads through autoModeSettingsPaths",
	"auto-mode/classifier-prompt.ts": "Claude Code's ruleset verbatim, regenerated, never hand-edited",
	"doctor/build.ts": "the mode line names what is read",
	"doctor/fix-prompt.ts": "an independent-mode ground rule maps every Claude Code path it names",
	"subagents/guide-agent.ts": "names the mode's own files",
};

/** Source without block and line comments, so a path named in prose is not a reader (`//` after `:` is a URL). */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path);
		return name.endsWith(".ts") || name.endsWith(".mjs") ? [path] : [];
	});
}

describe("config-mode guard", () => {
	it("every module naming a Claude Code location has been checked against independent mode", () => {
		const naming = walk(ROOT)
			.filter((path) => CLAUDE_LOCATION.test(withoutComments(readFileSync(path, "utf8"))))
			.map((path) => relative(ROOT, path).split("\\").join("/"));
		const unchecked = naming.filter((file) => !(file in CHECKED));
		expect(unchecked, "add each to CHECKED with how it treats independent mode").toEqual([]);
		const stale = Object.keys(CHECKED).filter((file) => !naming.includes(file));
		expect(stale, "these no longer name a Claude Code location; drop them from CHECKED").toEqual([]);
	});
});
