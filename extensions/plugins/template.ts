/**
 * Claude Code command-template expansion (pure apart from the shell hook).
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

export function substituteArguments(body: string, args: string): string {
	const parts = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
	return body
		.replace(/\$ARGUMENTS\b/g, args.trim())
		.replace(/\$@/g, args.trim())
		.replace(/\$(\d+)/g, (_match, index) => parts[Number(index) - 1] ?? "");
}

/** Finds each !`command` occurrence so the caller can run them. */
export function findShellPlaceholders(body: string): string[] {
	const found: string[] = [];
	const pattern = /!`([^`]+)`/g;
	let match = pattern.exec(body);
	while (match) {
		found.push(match[1]);
		match = pattern.exec(body);
	}
	return found;
}

export function replaceShellPlaceholders(body: string, outputs: Map<string, string>): string {
	return body.replace(/!`([^`]+)`/g, (_match, command: string) => outputs.get(command) ?? "");
}
