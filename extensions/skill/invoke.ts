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

/** Fast pre-check before the regex walk; also the marker `redactOffSkillText` scans for. */
const SKILL_BLOCK_START = '<skill name="';
const SKILL_BLOCK_RE = /<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;

export const offSkillNotice = (name: string): string =>
	`[Skill "${name}" is turned off — its instructions were removed. The user can re-enable it from /skills or /plugins.]`;

/**
 * Replace every `<skill>` block belonging to a turned-off skill with a short
 * refusal notice. Returns the rewritten text, or undefined when nothing
 * needed redacting (so callers keep the original object untouched).
 *
 * This is the fail-closed backstop behind the `input`-hook interception:
 * pi's `steer()`/`followUp()` expand `/skill:<name>` natively WITHOUT firing
 * the `input` event (queued interactive messages after the first, RPC
 * steer/followUp), so an off skill's instructions can land in the session
 * history. Redacting on the `context` hook strips them from every outgoing
 * request — the session file keeps the original bytes, and the rewrite is
 * deterministic for a fixed override state, so the request prefix stays
 * byte-stable across turns (prompt-cache friendly).
 */
export function redactOffSkillText(text: string, isOff: (name: string) => boolean): string | undefined {
	if (!text.includes(SKILL_BLOCK_START)) return undefined;
	let changed = false;
	const redacted = text.replace(SKILL_BLOCK_RE, (block, name: string) => {
		if (!isOff(name)) return block;
		changed = true;
		return offSkillNotice(name);
	});
	return changed ? redacted : undefined;
}

/**
 * Apply redactOffSkillText across a request's messages (user and custom roles,
 * string or text-block content). Returns a rewritten copy, or undefined when
 * no message needed redacting — callers must then keep the original array so
 * untouched requests stay byte-identical.
 */
export function redactOffSkillMessages<M extends { role: string; content?: unknown }>(
	messages: readonly M[],
	isOff: (name: string) => boolean,
): M[] | undefined {
	let changed = false;
	const out = messages.map((message) => {
		if (message.role !== "user" && message.role !== "custom") return message;
		if (typeof message.content === "string") {
			const redacted = redactOffSkillText(message.content, isOff);
			if (redacted === undefined) return message;
			changed = true;
			return { ...message, content: redacted };
		}
		if (!Array.isArray(message.content)) return message;
		let blockChanged = false;
		const blocks = message.content.map((block: { type?: string; text?: string }) => {
			if (block?.type !== "text" || typeof block.text !== "string") return block;
			const redacted = redactOffSkillText(block.text, isOff);
			if (redacted === undefined) return block;
			blockChanged = true;
			return { ...block, text: redacted };
		});
		if (!blockChanged) return message;
		changed = true;
		return { ...message, content: blocks };
	});
	return changed ? out : undefined;
}

// ---------------------------------------------------------------------------
// Bare `/<skill>` commands (Claude Code's invocation shape)

/**
 * pi's interactive built-ins, matched by literal text before anything reaches
 * an extension — a skill of the same name can never be invoked bare, so no
 * alias is registered for it (its `/skill:<name>` form still works).
 */
export const PI_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
	"bug",
	"changelog",
	"clone",
	"compact",
	"copy",
	"debug",
	"export",
	"fork",
	"hotkeys",
	"import",
	"login",
	"logout",
	"model",
	"name",
	"new",
	"quit",
	"reload",
	"resume",
	"scoped-models",
	"session",
	"settings",
	"share",
	"thinking",
	"tree",
	"trust",
]);

/** A skill name that can be a bare slash command: one token, no `:` (plugin skills stay `<plugin>:<skill>`, as in Claude Code). */
export function isBareCommandName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

/**
 * Which skills get a bare `/<name>` command, given the command names already
 * taken (other extensions' commands, `.claude/commands` templates, pi's
 * built-ins). Plugin skills are excluded (they keep `<plugin>:<skill>`), a
 * name already taken keeps its owner (first-registered command wins; pi would
 * otherwise rename BOTH to `name:1`/`name:2`), and a duplicate skill name
 * registers once. Pure, so the collision policy is testable.
 */
export function skillCommandCandidates<T extends { name: string; source: string }>(skills: T[], taken: Iterable<string>): T[] {
	const used = new Set<string>([...taken, ...PI_BUILTIN_COMMANDS]);
	const out: T[] = [];
	for (const skill of skills) {
		if (skill.source === "plugin" || !isBareCommandName(skill.name) || used.has(skill.name)) continue;
		used.add(skill.name);
		out.push(skill);
	}
	return out;
}
