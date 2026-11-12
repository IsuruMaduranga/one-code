/**
 * Whether a bash command touches one of the profile's secret files (pure
 * apart from the parser; lib/profile/secrets.ts has the names). The gate
 * refuses such a command in every mode, so the test is narrower than "the
 * text mentions the name": `echo Config.toml >> .gitignore` and a commit
 * message that names the file are ordinary work.
 *
 * A command touches the file when it redirects from or to it, or when a word
 * of the command names it, except:
 * - the words of a command that takes no file operands (`echo`, `printf`);
 * - the pattern of a pattern-first command (`grep Config.toml docs/`);
 * - a multi-word argument of `git` (a commit message).
 *
 * A word with spaces counts everywhere else, so `bash -c "cat Config.toml"`
 * is caught. A line the parser cannot read counts as touching: nothing can
 * be said about its words. Like every name check this steers rather than
 * seals (`cat *.toml`); the value redaction is the backstop.
 */

import { commandNamesSecretFile } from "../profile/secrets.ts";
import { NO_FILE_OPERANDS, PATTERN_FIRST_COMMANDS, parseCommand, resolvePayload } from "./shell-analysis.ts";

export function commandTouchesSecretFile(command: string, names: ReadonlySet<string>): boolean {
	const mentions = (text: string): boolean => commandNamesSecretFile(text, names);
	if (!mentions(command)) return false;
	const parsed = parseCommand(command);
	if (parsed.parseFailed || parsed.segments.length === 0) return true;
	for (const segment of parsed.segments) {
		if (segment.redirects.some(mentions) || segment.inputs.some((input) => mentions(input.value))) return true;
		const { command: name, args } = resolvePayload(segment.tokens);
		if (mentions(name)) return true;
		if (NO_FILE_OPERANDS.has(name)) continue;
		const pattern = PATTERN_FIRST_COMMANDS.has(name) ? args.find((arg) => !arg.value.startsWith("-")) : undefined;
		for (const arg of args) {
			if (arg === pattern || !mentions(arg.value)) continue;
			if (name === "git" && /\s/.test(arg.value)) continue;
			return true;
		}
	}
	return false;
}
