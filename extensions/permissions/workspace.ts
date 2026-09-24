/**
 * Workspace directories: Claude Code's additional working directories
 * (`permissions.additionalDirectories`, `--add-dir`, `/add-dir`, the
 * /permissions Workspace tab). Pure apart from the filesystem check in
 * `validateWorkspaceDirectory`.
 *
 * What one grants here (working-docs/decisions/modes.md, "Workspace
 * directories"): reads inside it are working-space reads in every mode, and
 * acceptEdits may write inside it. Auto mode's unclassified writes and
 * deletions stay confined to the working directory, a credential path inside
 * one is never a working-space read, and a directory from the repository's
 * own settings applies only after the user trusts the repository.
 */

import { statSync } from "node:fs";
import { delimiter, parse, resolve } from "node:path";
import { comparablePath, expandTilde, tryRealpath } from "../lib/paths.ts";
import { isWithin } from "../auto-mode/paths.ts";

export type ValidatedDirectory = { path: string } | { error: string };

/**
 * Check a directory the user wants to add, as Claude Code's
 * `validateDirectoryForWorkspace` does: it must exist and be a directory, and
 * must not already be covered by the working directory or another workspace
 * directory. One Code also refuses the filesystem root and the home directory
 * itself, which would make almost every read on the machine a working-space
 * read. `existing` holds the directories already in the workspace.
 */
export function validateWorkspaceDirectory(input: string, cwd: string, home: string, existing: readonly string[]): ValidatedDirectory {
	const trimmed = input.trim();
	if (!trimmed) return { error: "Enter a directory path." };
	const spelled = resolve(cwd, expandTilde(trimmed, home));
	// Compared where it resolves: the workspace list holds resolved paths, and on
	// macOS /var is /private/var.
	const path = tryRealpath(spelled) ?? spelled;
	let isDirectory = false;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		return { error: `${path} does not exist.` };
	}
	if (!isDirectory) return { error: `${path} is not a directory.` };
	const tooBroad = tooBroadForWorkspace(path, home);
	if (tooBroad) return { error: tooBroad };
	if (isWithin(tryRealpath(cwd) ?? resolve(cwd), path)) return { error: `${path} is already inside the working directory.` };
	const covering = existing.find((dir) => isWithin(dir, path));
	if (covering) return { error: `${path} is already in the workspace (${covering}).` };
	return { path };
}

/**
 * Why a directory is too broad to be a workspace directory, or undefined: the
 * filesystem root and the home directory itself would make almost every read
 * on the machine a working-space read. Every source is checked, settings files
 * included. `path` is judged as given, so resolve it first.
 */
export function tooBroadForWorkspace(path: string, home: string): string | undefined {
	if (parse(path).root === path) return "The filesystem root cannot be a workspace directory. Add a narrower directory.";
	if (comparablePath(path) === comparablePath(tryRealpath(home) ?? resolve(home))) {
		return "Your home directory cannot be a workspace directory. Add a narrower directory.";
	}
	return undefined;
}

/**
 * `--add-dir` takes one string (pi flags are single-valued), so several
 * directories are separated like PATH entries: `:` on macOS and Linux, `;` on
 * Windows.
 */
export function parseAddDirFlag(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(delimiter)
		.map((part) => part.trim())
		.filter(Boolean);
}
