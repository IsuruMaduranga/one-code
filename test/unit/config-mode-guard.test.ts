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
/** The profile's code reads Claude Code's files too (profile/claude-code/), and its text may name them. */
const PROFILE = join(import.meta.dirname, "..", "..", "profile");

/** Spellings of a Claude Code location in our source. */
const CLAUDE_LOCATION =
	/claudeUserDir\(|claudeConfigDir\(|claudeJsonPath\(|claudeUserSettingsPath\(|settingsPaths\(|managedSettingsPaths\(|["'`/]\.claude["'`/]|["'`]CLAUDE(\.local)?\.md["'`]/;

/** Each file, and how it treats independent mode. */
const CHECKED: Record<string, string> = {
	"lib/paths.ts": "defines the helpers",
	"lib/claude-settings.ts": "readers gate on claudeSourcesOn; managed paths are shared",
	"lib/claude-context.ts": "the oneCodeMd preamble names CLAUDE.md only in compatible mode",
	"lib/instructions.ts": "reads no Claude Code location; the banner groups a provider's .claude/AGENTS.md with its directory",
	"lib/memory-index.ts": "independent memory indexes cannot resolve into Claude Code locations",
	"lib/skill-scan.ts": "Claude Code skill folders only in compatible mode; commands via the config dirs",
	"lib/plugins.ts": "readClaudePlugins is false in independent mode",
	"lib/permission-gate.ts": "protection: ~/.claude stays protected and its secrets stay secret in both modes",
	"permissions/protected-paths.ts": "protection: .claude stays protected in both modes",
	"permissions/index.ts": ".claude.json flag and the ~/.claude allow warning gated",
	"auto-mode/safety-floor.ts": "protection: gate-control files stay on the floor in both modes",
	"auto-mode/setup-run.ts": "AGENTS.md and ONECODE.md in independent mode",
	"claude-compat/index.ts": "Claude Code skill and command folders only in compatible mode",
	"memory/index.ts": "the picker's entries follow the instruction rule",
	"memory/entries.ts": "independent rows offer ONECODE.md and AGENTS.md",
	"mcp/config.ts": "configPaths is empty in independent mode",
	"mcp/index.ts": "labels only; the source list is mode-aware",
	"mcp/trust.ts": "reads One Code's files in independent mode",
	"doctor/compat.ts": "reports what each source holds; the mode line says what is read",
	"auto-mode/classifier-prompt.ts": "Claude Code's ruleset verbatim, regenerated, never hand-edited",
	"doctor/build.ts": "the mode line names what is read",
	"profile/claude-code/instructions.ts": "One Code's instruction view: sources.ts opens it only in Claude-compatible mode",
	"profile/claude-code/sources.ts": "One Code's source provider: in independent mode its view only keeps Claude Code's locations out",
	"profile/doctor/fix-prompt.ts": "words only: names both modes' files, and says which the session reads",
	"profile/subagents/agent-description.ts": "words only: the caller passes the mode's config dir",
	"profile/subagents/guide-agent.ts": "words only: the caller passes which sources and config dir the mode reads",
	"profile/worktree/descriptions.ts": "words only: the caller passes the mode's config dir",
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
		const key = (path: string) => (path.startsWith(PROFILE) ? `profile/${relative(PROFILE, path)}` : relative(ROOT, path)).split("\\").join("/");
		const naming = [...walk(ROOT), ...walk(PROFILE)]
			.filter((path) => CLAUDE_LOCATION.test(withoutComments(readFileSync(path, "utf8"))))
			.map(key);
		const unchecked = naming.filter((file) => !(file in CHECKED));
		expect(unchecked, "add each to CHECKED with how it treats independent mode").toEqual([]);
		const stale = Object.keys(CHECKED).filter((file) => !naming.includes(file));
		expect(stale, "these no longer name a Claude Code location; drop them from CHECKED").toEqual([]);
	});
});
