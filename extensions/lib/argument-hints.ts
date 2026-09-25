/**
 * Claude Code's argument hint in the prompt: once the input is a slash command
 * that takes an argument plus one space (`/btw `), a dim placeholder for it
 * (`[question]`) follows the cursor until the user types the argument
 * (findings §34). A command file with an `arguments` list and no
 * `argument-hint` gets a progressive hint instead: the names not typed yet.
 *
 * pi shows an extension command's hint nowhere (its `registerCommand` has no
 * hint field), so a command extension announces its hint on
 * ARGUMENT_HINT_CHANNEL (`announceArgumentHint`, or `registerLocalCommand`'s
 * `argumentHint` option) and the branding extension's prompt editor draws it.
 * pi's own built-ins get theirs from PI_BUILTIN_HINTS.
 *
 * Every command that takes an argument has a hint: Claude Code's text where
 * Claude Code has the same command, else our own syntax in its bracket style
 * (`[optional]`, `<required>`). A command with no argument has none, as in
 * Claude Code.
 *
 * Pure: no pi imports.
 */

import { visibleWidth } from "./tui-render.ts";

export const ARGUMENT_HINT_CHANNEL = "one-code:argument-hint";

export interface ArgumentHint extends CommandHint {
	/** The command name, without the slash. */
	command: string;
}

/** What the prompt knows about one command's argument. */
export interface CommandHint {
	/** The placeholder shown after `/<command> `, e.g. `[question]`. */
	hint?: string;
	/** A command file's `arguments` names, for the progressive hint. */
	argNames?: string[];
}

/** The slice of pi's ExtensionAPI an announcement needs. */
export interface HintEmitter {
	events: { emit(channel: string, data: unknown): unknown };
	on?(event: "session_start", handler: () => void): unknown;
}

/**
 * Announce `/command`'s hint now and again at every `session_start`, so it
 * reaches the prompt editor whether the command registers at load or during
 * `session_start`. Repeats are harmless: the editor keeps one hint per command.
 */
export function announceArgumentHint(pi: HintEmitter, command: string, hint: string | CommandHint): void {
	const payload: ArgumentHint = { command, ...(typeof hint === "string" ? { hint } : hint) };
	const emit = () => pi.events.emit(ARGUMENT_HINT_CHANNEL, payload);
	emit();
	pi.on?.("session_start", emit);
}

/**
 * pi's built-in commands that take an argument. Claude Code's text where it has
 * the same command (`/model`, `/compact`, `/export`, and `/rename` for pi's
 * `/name`); pi's own `argumentHint` otherwise.
 */
export const PI_BUILTIN_HINTS: Readonly<Record<string, string>> = {
	model: "[model]",
	compact: "<optional custom summarization instructions>",
	export: "[filename]",
	name: "[name]",
	thinking: "<level>",
	login: "<provider>",
	bug: "<description>",
};

/**
 * A command file's hint (a SKILL.md, a plugin or template command): its
 * `argument-hint` string, and its `arguments` names (a space-separated string
 * or a list; numeric names are dropped, as they clash with `$0`, `$1`).
 * Undefined when it has neither.
 */
export function frontmatterCommandHint(frontmatter: Record<string, unknown> | undefined): CommandHint | undefined {
	const raw = frontmatter?.["argument-hint"];
	const hint = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
	const names = frontmatter?.arguments;
	const list = typeof names === "string" ? names.split(/\s+/) : Array.isArray(names) ? names : [];
	const argNames = list.filter((n): n is string => typeof n === "string" && n.trim() !== "" && !/^\d+$/.test(n));
	if (!hint && argNames.length === 0) return undefined;
	return { ...(hint && { hint }), ...(argNames.length > 0 && { argNames }) };
}

/** The words typed so far, quotes grouping (Claude Code's `parseArguments`, minus shell expansion). */
export function typedArguments(text: string): string[] {
	return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/**
 * The placeholder to draw after the cursor for the editor's `text`, or
 * undefined. Claude Code's rule: the input is `/<command> ` and nothing more
 * shows the command's hint; failing that, a command with `arguments` names
 * shows the names not typed yet whenever the input ends in a space.
 */
export function hintForInput(text: string, commands: ReadonlyMap<string, CommandHint>): string | undefined {
	if (!text.startsWith("/")) return undefined;
	const space = text.indexOf(" ");
	if (space === -1) return undefined;
	const command = commands.get(text.slice(1, space));
	if (!command) return undefined;
	if (command.hint && text.length === space + 1) return command.hint;
	if (command.argNames?.length && text.endsWith(" ")) {
		const remaining = command.argNames.slice(typedArguments(text.slice(space + 1)).length);
		return remaining.length > 0 ? remaining.map((name) => `[${name}]`).join(" ") : undefined;
	}
	return undefined;
}

/** The fake end-of-text cursor pi-tui's editor draws: an inverse space. */
const END_CURSOR = "\x1b[7m \x1b[0m";

/**
 * The editor's rendered lines with `placeholder` (already painted; its visible
 * width is measured) drawn into the blank padding after the end-of-text cursor
 * on the first content line. The line keeps its width. No-op when there is no
 * end cursor on that line or too little padding after it, so an unexpected
 * render shape shows no hint rather than a corrupted line.
 */
export function applyArgumentHint(lines: string[], placeholder: string): string[] {
	const line = lines[1];
	if (line === undefined) return lines;
	const at = line.lastIndexOf(END_CURSOR);
	if (at === -1) return lines;
	const tail = line.slice(at + END_CURSOR.length);
	const width = visibleWidth(placeholder);
	if (!/^ *$/.test(tail.slice(0, width)) || tail.length < width) return lines;
	const out = lines.slice();
	out[1] = line.slice(0, at + END_CURSOR.length) + placeholder + tail.slice(width);
	return out;
}
