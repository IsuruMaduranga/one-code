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

// commandBreadcrumb's shape at the start of a message; the arguments may span lines.
const BREADCRUMB = /^<command-message>[^<\n]*<\/command-message>\n<command-name>(\/[^<\n]*)<\/command-name>(?:\n<command-args>([\s\S]*?)<\/command-args>)?\n/;

/**
 * What a user message that opens with commandBreadcrumb shows in the
 * transcript: the command as typed, `/name args`. Claude Code shows a prompt
 * command (a skill, `/init`, `/doctor`) by its command line and keeps the
 * expanded text out of the transcript. `undefined` for any other message.
 */
export function commandDisplayLine(text: string): string | undefined {
	const match = BREADCRUMB.exec(text);
	if (!match) return undefined;
	return match[2] ? `${match[1]} ${match[2]}` : match[1];
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

/**
 * A prompt command (`/init`, `/doctor`, a plugin command) as one user message,
 * in a typed skill's exact bytes: Claude Code sends every prompt command led by
 * its breadcrumb, and the transcript shows it as its command line
 * (commandDisplayLine).
 */
export function promptCommandText(name: string, args: string, prompt: string): string {
	return typedSkillContent(name, args, prompt).join("\n");
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
