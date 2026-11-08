/**
 * One Code's half of the Claude Code locations guard (the base's half is
 * test/unit/claude-locations-guard.test.ts): in this profile, only the
 * Claude Code provider and the words its callers fill in name a Claude Code
 * location. A new one fails here until it is listed with its reason. The
 * profile's own tests (this folder) are not readers and are skipped.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesNamingClaudeLocations } from "../../test/unit/helpers/claude-locations.ts";

const PROFILE = join(import.meta.dirname, "..");

/** The profile files that name one: One Code's provider, and words its callers fill in. */
const PROFILE_FILES: Record<string, string> = {
	"text/auto-mode/ruleset.ts": "Claude Code's classifier ruleset verbatim, generated, never hand-edited",
	"claude-code/instructions.ts": "One Code's instruction view: sources.ts opens it only with the provider on",
	"claude-code/settings.ts": "Claude Code's settings paths and instructionFiles rule, for the provider",
	"claude-code/sources.ts": "One Code's source provider: switched off, its view only keeps Claude Code's locations out",
	"text/init/prompt.ts": "words only: the caller passes the target file (instructionTargets); INIT_PROMPT is the CLAUDE.md one",
	"text/doctor/fix-prompt.ts": "words only: names both modes' files, and says which the session reads",
	"text/subagents/agent-description.ts": "words only: the caller passes the config dir",
	"text/worktree/descriptions.ts": "words only: the caller passes the config dir",
};

describe("Claude Code locations in One Code's profile", () => {
	it("are named only by the provider and the words its callers fill in", () => {
		const naming = filesNamingClaudeLocations(PROFILE, [join(PROFILE, "test")]);
		const unchecked = naming.filter((file) => !(file in PROFILE_FILES));
		expect(unchecked, "move the reader into the source provider (claude-code/), or list it in PROFILE_FILES with its reason").toEqual([]);
		const stale = Object.keys(PROFILE_FILES).filter((file) => !naming.includes(file));
		expect(stale, "these no longer name a Claude Code location; drop them from PROFILE_FILES").toEqual([]);
	});
});
