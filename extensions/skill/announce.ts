/**
 * What to tell the model when the skill set changes (pure).
 *
 * The skills listing is a `first-prepend` reminder on message 1, so once a
 * request has gone out it is the record every later request in the epoch
 * replays (extensions/ledger); rewriting it would also break the binding of
 * every earlier signed thinking block (findings §46). As in Claude Code, a
 * skill that becomes listable later is announced on the request's tail under
 * the listing's own header, and a skill that leaves the listing is not
 * announced: the skill tool refuses it by name. A compaction opens an epoch
 * and re-lists every skill.
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
