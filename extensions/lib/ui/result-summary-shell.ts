/**
 * The transcript's short line for a shell command a guard refused (pure).
 * The model reads the guard's whole paragraph (what tripped it, why, what to
 * do instead); the user needs only what happened. The kind rides the result's
 * `details.blocked` (lib/shell-run/shell-tool.ts), which never reaches the
 * model. No reference UI shows these refusals; the words are ours.
 */

import type { ShellBlock } from "../shell-run/shell-text.ts";

const BLOCKED_LINES: Record<ShellBlock["kind"], string> = {
	sleep: "Blocked: a foreground sleep",
	pollingLoop: "Blocked: a foreground polling loop",
	detach: "Blocked: a detached process",
	editor: "Blocked: an interactive editor",
	watch: "Blocked: watch needs a terminal",
	rebaseInteractive: "Blocked: an interactive rebase",
	addInteractive: "Blocked: an interactive git add",
	consolePrompt: "Blocked: the command waits on a prompt",
};

/** The short line for a refused command, from its result's details; undefined for any other result. */
export function shellBlockedLine(details: unknown): string | undefined {
	const kind = (details as { blocked?: unknown } | undefined)?.blocked;
	return typeof kind === "string" && Object.hasOwn(BLOCKED_LINES, kind) ? BLOCKED_LINES[kind as ShellBlock["kind"]] : undefined;
}
