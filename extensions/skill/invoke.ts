/**
 * User-invoked skill commands (pure). pi registers each skill as a `/skill:<name>`
 * slash command and, on invocation, expands it into a `<skill>` block that it
 * submits as a *user message* — so loading a skill shows up in the transcript as
 * a new user turn. One Code intercepts that command in the `input` hook and
 * re-delivers the same block as a hidden message instead (see index.ts), so the
 * model receives byte-identical content but nothing renders.
 *
 * These helpers mirror pi's own `_expandSkillCommand`/`formatSkillInvocation`
 * exactly (same `/skill:` prefix, same block template) so the model sees the same
 * bytes it would have without the interception — only the display changes.
 */

import { dirname } from "node:path";

const SKILL_PREFIX = "/skill:";

/** Parse a `/skill:<name> [args]` command; undefined if it is not one. */
export function parseSkillCommand(text: string): { name: string; args: string } | undefined {
	if (!text.startsWith(SKILL_PREFIX)) return undefined;
	const rest = text.slice(SKILL_PREFIX.length);
	const space = rest.indexOf(" ");
	if (space === -1) return { name: rest, args: "" };
	return { name: rest.slice(0, space), args: rest.slice(space + 1).trim() };
}

/** Skills whose name ends `:<wanted>` — a bare name's plugin-namespaced matches. */
export function bareSkillMatches<T extends { name: string }>(all: T[], wanted: string): T[] {
	return all.filter((skill) => skill.name.endsWith(`:${wanted}`));
}

/**
 * Resolve a bare skill name against the available skills, matching the Skill
 * tool's own resolution: exact, then case-insensitive, then a unique
 * `<plugin>:<name>` suffix. Returns undefined when nothing matches or a bare
 * name is ambiguous across plugins (so the caller falls back to pi's handling).
 */
export function resolveSkill<T extends { name: string }>(all: T[], wanted: string): T | undefined {
	const bare = bareSkillMatches(all, wanted);
	return (
		all.find((skill) => skill.name === wanted) ??
		all.find((skill) => skill.name.toLowerCase() === wanted.toLowerCase()) ??
		(bare.length === 1 ? bare[0] : undefined)
	);
}

/**
 * Rebuild the exact `<skill>` block pi's `/skill:` expansion produces. `body` is
 * the SKILL.md with frontmatter already stripped and trimmed; `filePath` is the
 * skill file (its directory is the base for relative references, as pi does).
 */
export function buildSkillBlock(skill: { name: string; filePath: string }, body: string, args: string): string {
	const block = `<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${dirname(skill.filePath)}.

${body}
</skill>`;
	return args ? `${block}\n\n${args}` : block;
}
