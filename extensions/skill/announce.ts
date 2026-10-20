/**
 * What to tell the model when the skill set changes (pure).
 *
 * The skills listing is a `first-prepend` reminder on message 1, so once a
 * request has gone out it is part of every later request's cached prefix, and
 * rewriting it also breaks the binding of every earlier signed thinking block
 * (findings §46). So it is FROZEN after the first request, as the deferred-tools
 * listing is (tool-search/announce.ts), and follows Claude Code's
 * `sentSkillNames`: a skill that becomes listable later is announced in a
 * one-shot under the listing's own header; a skill that leaves the listing is
 * not announced, and the skill tool refuses it by name. A compaction starts a
 * new prefix and re-lists every skill.
 */

import { skillListingVisibility } from "../lib/skill-overrides.ts";
import type { ListedSkill } from "./listing.ts";

/** The header Claude Code puts over its skills listing, initial or later. */
export const SKILL_LISTING_HEADER = "The following skills are available for use with the Skill tool:";

/**
 * The names the listing shows. `readable` is the read-the-file framing for a
 * session without the skill tool, which also leaves out plugin commands and
 * skills without a file (listing.ts `readableSkillListing`).
 */
export function listableSkillNames(skills: ReadonlyArray<ListedSkill & { path?: string; kind?: string }>, readable: boolean): string[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation && skillListingVisibility(skill.state) !== "hidden")
		.filter((skill) => !readable || (!skill.kind && skill.path))
		.map((skill) => skill.name);
}

/** JSON-safe persisted baseline: the names the model has been shown. */
export function listedSkillsBaseline(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return undefined;
	return [...new Set(value)];
}

/**
 * The names in a stored listing, for a session saved before the baseline
 * existed. A line is `- <name>`, `- <name>: <description>` or, in the
 * read-the-file framing, `- <name> (<path>)`; a plugin skill's name has a
 * colon of its own (`<plugin>:<skill>`), never followed by a space.
 */
export function skillNamesFromListing(text: string | undefined): string[] | undefined {
	if (!text) return undefined;
	const names = text
		.split("\n")
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).split(/: | \(/)[0].trim())
		.filter(Boolean);
	return names.length > 0 ? names : undefined;
}
