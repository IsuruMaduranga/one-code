/**
 * The model-facing skills listing (pure). The state decides visibility: "on"
 * carries name + description, "name-only" just the name (saving context
 * tokens), "user-only"/"off" are hidden so the model won't auto-trigger them.
 * A skill whose frontmatter sets `disable-model-invocation: true` is hidden
 * whatever its state: only the user may start it, as in Claude Code.
 *
 * Each line is built the way Claude Code builds it: the description, then
 * " - " and the `when_to_use` frontmatter when there is one, clipped at 1,536
 * characters (1,535 and an ellipsis). The description keeps its newlines: a
 * skill written with a YAML block description puts its "Use when…" trigger on
 * the later lines, and a first-line-only listing dropped exactly the sentence
 * that tells the model when to reach for the skill.
 *
 * The whole listing has a budget, 1% of the context window in characters
 * (`SLASH_COMMAND_TOOL_CHAR_BUDGET` replaces it). Over budget, a bundled skill
 * and a name-only one keep their lines; the others keep theirs by usage rank
 * while the budget lasts and are listed by name after that.
 */

import { type SkillState, skillListingVisibility } from "../lib/skill-overrides.ts";
import type { UsageEntry } from "../lib/usage-tracker.ts";

/** Claude Code's per-entry cap (its `skillListingMaxDescChars` default). */
export const SKILL_DESCRIPTION_CAP = 1536;
/** The listing's share of the context window, at 4 characters per token, 200K tokens when the window is unknown. */
const BUDGET_FRACTION = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ListedSkill {
	name: string;
	description?: string;
	/** The `when_to_use` frontmatter, appended after " - ". */
	whenToUse?: string;
	state: SkillState;
	disableModelInvocation?: boolean;
	/** Ships inside One Code: keeps its line over budget, as Claude Code's bundled skills do. */
	bundled?: boolean;
	/** The usage score that ranks the line over budget (`usageScore`). */
	usage?: number;
}

/** The text after `- <name>: `, clipped as Claude Code clips it. */
export function listingDescription(skill: Pick<ListedSkill, "description" | "whenToUse">): string {
	const description = skill.description?.trim() ?? "";
	const whenToUse = skill.whenToUse?.trim();
	const text = whenToUse ? `${description} - ${whenToUse}` : description;
	return text.length > SKILL_DESCRIPTION_CAP ? `${text.slice(0, SKILL_DESCRIPTION_CAP - 1)}…` : text;
}

/** The listing's character budget for a context window (tokens). */
export function skillListingBudget(contextWindow: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
	const fromEnv = Number.parseInt(env.SLASH_COMMAND_TOOL_CHAR_BUDGET ?? "", 10);
	if (fromEnv > 0) return fromEnv;
	const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
	return Math.max(1, Math.floor(window * CHARS_PER_TOKEN * BUDGET_FRACTION));
}

/** Claude Code's ranking score: uses, halved every week since the last one, never below a tenth. */
export function usageScore(entry: UsageEntry | undefined, now: Date = new Date()): number {
	if (!entry) return 0;
	const last = Date.parse(entry.lastUsedAt);
	if (Number.isNaN(last)) return 0;
	const days = (now.getTime() - last) / 86_400_000;
	return entry.count * Math.max(0.5 ** (days / 7), 0.1);
}

export function skillListingText(skills: ReadonlyArray<ListedSkill>, budget = Number.POSITIVE_INFINITY): string {
	const listed = skills.flatMap((skill) => {
		if (skill.disableModelInvocation) return [];
		const visibility = skillListingVisibility(skill.state);
		if (visibility === "hidden") return [];
		const short = `- ${skill.name}`;
		if (visibility === "name") return [{ skill, short, full: short }];
		const text = listingDescription(skill);
		return [{ skill, short, full: text ? `${short}: ${text}` : short }];
	});
	if (listed.length === 0) return "(no skills available)";
	const separators = listed.length - 1;
	const whole = listed.reduce((sum, line) => sum + line.full.length, 0) + separators;
	if (whole <= budget) return listed.map((line) => line.full).join("\n");

	// A name-only line's full form is its short form, so it needs no place in `kept`.
	const kept = new Set(listed.filter((line) => line.skill.bundled));
	const ranked = listed.filter((line) => !kept.has(line));
	let left = budget - (listed.reduce((sum, line) => sum + (kept.has(line) ? line.full.length : line.short.length), 0) + separators);
	// A stable sort: equal scores keep the listing's order.
	for (const line of [...ranked].sort((a, b) => (b.skill.usage ?? 0) - (a.skill.usage ?? 0))) {
		const extra = line.full.length - line.short.length;
		if (extra > left) continue;
		kept.add(line);
		left -= extra;
	}
	return listed.map((line) => (kept.has(line) ? line.full : line.short)).join("\n");
}

/**
 * Claude Code's reading of a boolean frontmatter flag such as
 * `disable-model-invocation`: `true` or the string `"true"`, nothing else.
 */
export function frontmatterFlag(value: unknown): boolean {
	return value === true || value === "true";
}
