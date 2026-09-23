/**
 * Claude Code's argument hint in the prompt: once the input is exactly a slash
 * command that takes an argument (`/btw`), a dim placeholder for it
 * (`[question]`) follows the cursor until the user types the argument.
 *
 * pi shows an extension command's hint nowhere (its `registerCommand` has no
 * hint field), so a command extension announces its hint on
 * ARGUMENT_HINT_CHANNEL at `session_start`, when every extension has loaded,
 * and the branding extension's prompt editor draws it.
 *
 * Pure: no pi imports.
 */

import { visibleWidth } from "./tui-render.ts";

export const ARGUMENT_HINT_CHANNEL = "one-code:argument-hint";

export interface ArgumentHint {
	/** The command name, without the slash. */
	command: string;
	/** The placeholder shown after it, e.g. `[question]`. */
	hint: string;
}

/**
 * The placeholder to draw for the editor's `text`, or undefined when the input
 * is not a bare hinted command. A single space after the command is allowed
 * (the user is about to type the argument); the placeholder then sits right
 * after the cursor instead of one space after it.
 */
export function hintForInput(text: string, hints: ReadonlyMap<string, string>): string | undefined {
	const match = /^\/(\S+)( ?)$/.exec(text);
	const hint = match ? hints.get(match[1]) : undefined;
	if (!hint) return undefined;
	return match![2] ? hint : ` ${hint}`;
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
