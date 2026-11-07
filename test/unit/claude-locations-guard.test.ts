/**
 * Phase 4b's exit check (working-docs/features/profiles/plan.md): Claude Code
 * compatibility is One Code's profile code. In the base (extensions/), only
 * the protective lists name a Claude Code location: they keep `~/.claude`
 * protected in every product (decisions/bi-fork.md, "The line"). Everything
 * that reads Claude Code's files lives in profile/claude-code/, behind the
 * source provider, which independent mode switches off. A new reader fails
 * here until it moves to the profile or is shown to be protective.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "extensions");
/** The profile's code reads Claude Code's files too (profile/claude-code/), and its text may name them. */
const PROFILE = join(import.meta.dirname, "..", "..", "profile");

/** Spellings of a Claude Code location in our source. */
const CLAUDE_LOCATION =
	/claudeUserDir\(|claudeConfigDir\(|claudeJsonPath\(|claudeManagedDir\(|claudeUserSettingsPath\(|settingsPaths\(|managedSettingsPaths\(|isClaudeLocation\(|["'`/]\.claude["'`/]|["'`]CLAUDE(\.local)?\.md["'`]/;

/** The base files that may name one, and why: protection only, kept in every product. */
const PROTECTIVE: Record<string, string> = {
	"lib/paths.ts": "defines the helpers the protective lists and the provider use",
	"lib/claude-settings.ts": "protection: the user and managed settings paths the safety floor guards",
	"lib/permission-gate.ts": "protection: ~/.claude stays protected and its secrets stay secret",
	"permissions/protected-paths.ts": "protection: .claude stays a protected directory",
	"auto-mode/safety-floor.ts": "protection: gate-control files stay on the floor",
};

/** The profile files that name one: One Code's provider, and words its callers fill in. */
const PROFILE_FILES: Record<string, string> = {
	"profile/text/auto-mode/ruleset.ts": "Claude Code's classifier ruleset verbatim, generated, never hand-edited",
	"profile/claude-code/instructions.ts": "One Code's instruction view: sources.ts opens it only with the provider on",
	"profile/claude-code/settings.ts": "Claude Code's settings paths and instructionFiles rule, for the provider",
	"profile/claude-code/sources.ts": "One Code's source provider: switched off, its view only keeps Claude Code's locations out",
	"profile/text/init/prompt.ts": "words only: the caller passes the target file (instructionTargets); INIT_PROMPT is the CLAUDE.md one",
	"profile/text/doctor/fix-prompt.ts": "words only: names both modes' files, and says which the session reads",
	"profile/text/subagents/agent-description.ts": "words only: the caller passes the config dir",
	"profile/text/worktree/descriptions.ts": "words only: the caller passes the config dir",
};
const CHECKED: Record<string, string> = { ...PROTECTIVE, ...PROFILE_FILES };

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

describe("Claude Code locations", () => {
	it("are named in the base only by the protective lists, and otherwise only in the profile", () => {
		const key = (path: string) => (path.startsWith(PROFILE) ? `profile/${relative(PROFILE, path)}` : relative(ROOT, path)).split("\\").join("/");
		const naming = [...walk(ROOT), ...walk(PROFILE)]
			.filter((path) => CLAUDE_LOCATION.test(withoutComments(readFileSync(path, "utf8"))))
			.map(key);
		const unchecked = naming.filter((file) => !(file in CHECKED));
		expect(unchecked, "move the reader behind the source provider (profile/claude-code/), or add a protective file to PROTECTIVE with its reason").toEqual([]);
		const stale = Object.keys(CHECKED).filter((file) => !naming.includes(file));
		expect(stale, "these no longer name a Claude Code location; drop them from CHECKED").toEqual([]);
	});
});
