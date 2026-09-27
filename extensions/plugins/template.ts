/**
 * Claude Code command-template expansion (pure; `shell-expand.ts` runs the commands).
 *
 * A command markdown file has frontmatter (`description`, `allowed-tools`,
 * `argument-hint`) and a body that may contain:
 *   $ARGUMENTS, $1, $2, $@   — the invocation's arguments
 *   !`shell command`          — replaced with that command's output
 *
 * The `!` form is why plugin commands like `commit` work: the template gathers
 * git status and diff before the model sees the prompt.
 */

export interface CommandTemplate {
	description?: string;
	argumentHint?: string;
	allowedTools?: string;
	body: string;
}

/**
 * Replace `$ARGUMENTS`, `$@` and `$1`… with the invocation's arguments. With
 * `quote`, each argument word is passed through it (a shell placeholder's
 * command gets them as quoted words), so `$ARGUMENTS` stays one word per
 * argument and no argument can add shell syntax.
 */
export function substituteArguments(body: string, args: string, quote?: (word: string) => string): string {
	const parts = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
	const all = quote ? parts.map(quote).join(" ") : args.trim();
	// One pass: a second pass would substitute inside argument text the first
	// one inserted (an argument holding `$1`), unquoting it.
	return body.replace(/\$ARGUMENTS\b|\$@|\$(\d+)/g, (_match, index: string | undefined) => {
		if (index === undefined) return all;
		const part = parts[Number(index) - 1];
		return quote ? quote(part ?? "") : (part ?? "");
	});
}

export type TemplatePiece = { kind: "text"; text: string } | { kind: "shell"; command: string };

/**
 * A template body split into text and `` !`command` `` placeholders, found in
 * the body as written: an argument substituted later can never become a
 * placeholder. Until 2026-09-27 the arguments went in first, so an argument
 * holding `` !`…` `` ran as a command of its own.
 */
export function splitShellPlaceholders(body: string): TemplatePiece[] {
	const pieces: TemplatePiece[] = [];
	const pattern = /!`([^`]+)`/g;
	let last = 0;
	let match = pattern.exec(body);
	while (match) {
		if (match.index > last) pieces.push({ kind: "text", text: body.slice(last, match.index) });
		pieces.push({ kind: "shell", command: match[1] });
		last = match.index + match[0].length;
		match = pattern.exec(body);
	}
	if (last < body.length) pieces.push({ kind: "text", text: body.slice(last) });
	return pieces;
}
