/**
 * Phase 4b's exit check (working-docs/features/profiles/plan.md): Claude Code
 * compatibility is One Code's profile code. In the base (extensions/), only
 * the protective lists name a Claude Code location: they keep `~/.claude`
 * protected in every product (decisions/bi-fork.md, "The line"). Everything
 * that reads Claude Code's files lives in profile/claude-code/, behind the
 * source provider, which independent mode switches off. A new reader fails
 * here until it moves to the profile or is shown to be protective. One
 * Code's profile keeps its own list (profile/test/claude-locations-profile.test.ts).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareWithAllowlist, filesNamingClaudeLocations } from "./helpers/claude-locations.ts";

const ROOT = join(import.meta.dirname, "..", "..", "extensions");

/** The base files that may name one, and why: protection only, kept in every product. */
const PROTECTIVE: Record<string, string> = {
	"lib/paths.ts": "defines the helpers the protective lists and the provider use",
	"lib/claude-settings.ts": "protection: the user and managed settings paths the safety floor guards",
	"lib/permission-gate.ts": "protection: ~/.claude stays protected and its secrets stay secret",
	"lib/rules/protected-paths.ts": "protection: .claude stays a protected directory",
	"permissions/auto-mode/safety-floor.ts": "protection: gate-control files stay on the floor",
};

describe("Claude Code locations", () => {
	it("are named in the base only by the protective lists", () => {
		const naming = filesNamingClaudeLocations(ROOT);
		const { unlisted, stale } = compareWithAllowlist(naming, PROTECTIVE);
		expect(unlisted, "move the reader behind the source provider (profile/claude-code/), or add a protective file to PROTECTIVE with its reason").toEqual([]);
		expect(stale, "these no longer name a Claude Code location; drop them from PROTECTIVE").toEqual([]);
	});
});
