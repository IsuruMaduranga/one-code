/**
 * Project instruction files for the classifier (pure fs).
 *
 * Claude Code's classifier reads the same CLAUDE.md the agent does, so an
 * instruction like "never force push" steers both at once. This collects the
 * same files: cwd upward to the git root, plus the user's global file.
 *
 * These files are checked in, so they are untrusted input in a way the user's
 * own messages are not — the classifier prompt tells the model they may tighten
 * what is allowed but never widen it. That asymmetry is what makes including
 * them safe; without it, a repository could ship its own authorisation.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];

/** Per-file and total caps, so a large instruction file cannot crowd out rules. */
const PER_FILE_LIMIT = 6_000;
const TOTAL_LIMIT = 12_000;

function readCapped(path: string): string | undefined {
	try {
		// readFileSync loads the whole file regardless, so the cap is applied to the
		// decoded string. (A prior statSync branch claimed to bound the read but did
		// the same full read either way.)
		return readFileSync(path, "utf-8").slice(0, PER_FILE_LIMIT);
	} catch {
		return undefined;
	}
}

function findGitRoot(from: string): string | undefined {
	let dir = from;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Concatenated instruction files, nearest first, or undefined when there are
 * none. Each is labelled with its path so the classifier can tell project
 * convention from user-global preference.
 */
export function loadProjectInstructions(cwd: string, home: string): string | undefined {
	const stop = findGitRoot(cwd) ?? cwd;
	const parts: string[] = [];
	let total = 0;

	const add = (path: string) => {
		if (total >= TOTAL_LIMIT || !existsSync(path)) return;
		const body = readCapped(path)?.trim();
		if (!body) return;
		const chunk = `# ${path}\n${body}`;
		parts.push(chunk.slice(0, TOTAL_LIMIT - total));
		total += chunk.length;
	};

	let dir = cwd;
	for (;;) {
		for (const name of FILE_NAMES) add(join(dir, name));
		if (dir === stop) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	add(join(home, ".claude", "CLAUDE.md"));

	return parts.length > 0 ? parts.join("\n\n") : undefined;
}
