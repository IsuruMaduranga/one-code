/**
 * The model-facing skills listing (pure). The state decides visibility: "on"
 * carries name + description, "name-only" just the name (saving context
 * tokens), "user-only"/"off" are hidden so the model won't auto-trigger them.
 * A skill whose frontmatter sets `disable-model-invocation: true` is hidden
 * whatever its state: only the user may start it, as in Claude Code.
 * The description goes in whole, newlines included, the way Claude Code lists
 * it: a skill written with a YAML block description puts its "Use when…"
 * trigger on the later lines, and a first-line-only listing dropped exactly
 * the sentence that tells the model when to reach for the skill.
 */

import { type SkillState, skillListingVisibility } from "../lib/skill-overrides.ts";

export function skillListingText(
	skills: ReadonlyArray<{ name: string; description?: string; state: SkillState; disableModelInvocation?: boolean }>,
): string {
	const lines = skills.flatMap((skill) => {
		if (skill.disableModelInvocation) return [];
		const visibility = skillListingVisibility(skill.state);
		if (visibility === "hidden") return [];
		if (visibility === "name") return [`- ${skill.name}`];
		return [`- ${skill.name}${skill.description?.trim() ? `: ${skill.description.trim()}` : ""}`];
	});
	return lines.length === 0 ? "(no skills available)" : lines.join("\n");
}

/**
 * Claude Code's reading of a boolean frontmatter flag such as
 * `disable-model-invocation`: `true` or the string `"true"`, nothing else.
 */
export function frontmatterFlag(value: unknown): boolean {
	return value === true || value === "true";
}
