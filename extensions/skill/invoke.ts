/**
 * User-invoked skill commands (pure). pi registers each skill as a `/skill:<name>`
 * slash command and, on invocation, expands it into a `<skill>` block that it
 * submits as a *user message*. One Code intercepts that command (and its own
 * bare `/<name>` and typed `/<plugin>:<skill>` forms) and delivers the skill
 * the way Claude Code does: a hidden message holding the command breadcrumb
 * and the skill's text, so nothing renders and no `skill` call is needed.
 * A model's `skill` call gets Claude Code's "Launching skill" result with the
 * same text beside it (see index.ts).
 *
 * pi's own `<skill>` block still reaches a session through pi's native
 * expansion on older pi (steer/followUp skip the `input` hook there), which
 * is why the off-skill redaction below still matches it.
 */

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
 * Claude Code's breadcrumb for a typed slash command, the first text block of
 * the message a typed skill becomes. Its arguments ride `<command-args>` only
 * when there are some.
 */
export function commandBreadcrumb(name: string, args: string): string {
	return `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args ? `\n<command-args>${args}</command-args>` : ""}\n`;
}

/**
 * Claude Code's argument substitution in a skill's text: `$ARGUMENTS`,
 * `$ARGUMENTS[n]` and `$n` (both counted from 0) take the arguments, and a
 * backslash keeps a `$` literal. When nothing was substituted, the arguments
 * follow the text on an `ARGUMENTS:` line.
 */
export function substituteSkillArguments(text: string, args: string): string {
	if (!args.trim()) return text;
	const parts = args.trim().split(/\s+/);
	let used = false;
	// One pass, so an argument holding `$0` is never substituted again.
	const out = text.replace(/\\\$(?=\d|ARGUMENTS)|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)(?!\w)/g, (match, listed?: string, positional?: string) => {
		if (match.startsWith("\\")) return "$";
		if (match === "$ARGUMENTS") {
			used = true;
			return args;
		}
		const part = parts[Number(listed ?? positional)];
		if (part === undefined) return match;
		used = true;
		return part;
	});
	return used ? out : `${out}\n\nARGUMENTS: ${args}`;
}

/**
 * The text a skill hands the model, as Claude Code builds it: the skill's
 * folder first (`Base directory for this skill: …`, so relative `references/`
 * and `scripts/` resolve), then the body with its arguments. A skill that
 * ships inside One Code, like Claude Code's own, names no folder.
 */
export function skillPromptText(body: string, args: string, baseDir: string | undefined): string {
	const text = substituteSkillArguments(body, args);
	return baseDir ? `Base directory for this skill: ${baseDir}\n\n${text}` : text;
}

/**
 * The message a typed skill command becomes, as Claude Code sends it: the
 * breadcrumb, then the skill's text, each ending in a newline. Arguments a
 * generated body already carries are not passed again.
 */
export function typedSkillContent(name: string, typedArgs: string, promptText: string): [string, string] {
	return [commandBreadcrumb(name, typedArgs), promptText.endsWith("\n") ? promptText : `${promptText}\n`];
}

/** Claude Code's result for a model's skill call; the skill's text follows it as a second block. */
export const launchingSkill = (name: string): string => `Launching skill: ${name}`;

/**
 * The lines that open and close a skill tool result when the model called a
 * skill that takes arguments without passing any. A skill's text is its
 * instructions, not a manual: a weak model "checking the interface" of
 * `/loop` got the no-argument body, which starts an autonomous loop. A mild
 * opening line lost to that body's "The user invoked /loop with no prompt"
 * on DeepSeek V4.1 Flash; telling it to stop and check, plus a closing
 * reminder, turned it around. Only the model's tool calls get this; a user's
 * bare `/<name>` is deliberate.
 */
export function missingArgumentsNote(argumentHint: string): { before: string; after: string } {
	return {
		before: `Stop and check before following this. This skill takes arguments (${argumentHint}) and this call passed none, so what follows is its no-argument mode, written as if the user asked for the skill with nothing after it. If the user's request names any of those arguments, do not follow the instructions below: call the skill again with them in \`args\`.`,
		after: "Reminder: those were the no-argument instructions. If the user's request included arguments, call the skill again with them in `args` instead of following them.",
	};
}

/** Fast pre-check before the regex walk; also the marker `redactOffSkillText` scans for. */
const SKILL_BLOCK_START = '<skill name="';
const SKILL_BLOCK_RE = /<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;

/**
 * The hidden message a `/skill:` command is delivered as. `details.input` is
 * the text the user typed, so an extension that saw that text at `input` (the
 * hooks extension's UserPromptSubmit context) can find the message that
 * replaced it.
 */
export const SKILL_INVOCATION_TYPE = "one-code:skill-invocation";
export interface SkillInvocationDetails {
	skill: string;
	args: string;
	input?: string;
}

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

/**
 * The `/` suggestions without pi's `/skill:<name>` entry for a skill that also
 * has its bare `/<name>` command, so each skill is listed once, as in Claude
 * Code. Kept when the user is typing `/skill:` themselves, and for a skill
 * whose bare name was skipped (a collision), where `/skill:` is its only form.
 * Typed `/skill:<name>` still runs either way: this only trims the list.
 */
export function withoutDuplicateSkillCommands<T extends { value: string }>(items: T[], prefix: string, bareSkills: ReadonlySet<string>): T[] {
	if (!prefix.startsWith("/") || prefix.startsWith("/skill:")) return items;
	return items.filter((item) => !(item.value.startsWith("skill:") && bareSkills.has(item.value.slice("skill:".length))));
}
