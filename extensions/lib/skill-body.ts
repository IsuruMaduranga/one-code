/**
 * Skills whose body is generated, not read from their SKILL.md: Claude Code's
 * `/loop` builds a different prompt per argument shape (findings §21). The
 * skill extension emits a `SkillBodyQuery` on SKILL_BODY_CHANNEL before it
 * delivers a skill; the extension that owns the skill fills `body`
 * synchronously, and the SKILL.md body is the fallback.
 *
 * A fired scheduled prompt that is a slash command (`/loop check the deploy`,
 * `/babysit-prs`) runs the way Claude Code runs it, as if typed: the
 * background extension emits a `SlashExpandQuery` on SLASH_EXPAND_CHANNEL
 * and the skill extension fills `expanded` with the skill's block.
 *
 * Pure: no pi imports.
 */

export const SKILL_BODY_CHANNEL = "one-code:skill-body";
export const SLASH_EXPAND_CHANNEL = "one-code:slash-expand";

export interface SkillBodyQuery {
	/** The skill's name. */
	skill: string;
	/** Its SKILL.md, so a provider answers only for its own file. */
	path: string;
	args: string;
	cwd: string;
	/** Set by the provider; the arguments are then part of it. */
	body?: string;
}

export interface SlashExpandQuery {
	/** The fired prompt, starting with `/`. */
	text: string;
	cwd: string;
	/** Set by the skill extension when the command is a skill. */
	expanded?: string;
}

/** `/name rest` split, or undefined when `text` is not a slash command. */
export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1], args: (match[2] ?? "").trim() } : undefined;
}
