/**
 * The entries shown in the `/memory` panel and checked by the startup size
 * warning — mirroring Claude Code's picker, extended to the files One Code also
 * loads. Pure (fs reads only for existence), so the ordering and labelling are
 * unit-testable.
 *
 * Order matches CC top-to-bottom: the global user `CLAUDE.md` first (always
 * offered, editors create it on save), then each project directory from the
 * farthest ancestor down to the cwd. One Code adds its own loaded files:
 * `AGENTS.md` (reused via `@AGENTS.md` imports) and `ONECODE.md` (global +
 * per-dir, One Code-only). The auto-memory folder is the last entry, opening the
 * directory rather than a file.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { collectImportedPaths, discoverContextFilePaths } from "../lib/claude-context.ts";

export interface MemoryEntry {
	/** Left-hand label: a friendly role name for known files, else the path. */
	title: string;
	/** Right-hand description, for the CC-known roles. */
	description?: string;
	/** Absolute path the entry opens. */
	path: string;
	kind: "file" | "folder";
	/** File already on disk. The two create-on-open primaries may be false; folders are always true. */
	exists: boolean;
}

/** One Code instruction filenames, preference order (first present per dir wins). */
const ONECODE_NAMES = ["ONECODE.md", "onecode.md", "OneCode.md"];

function isFile(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

function oneCodeIn(dir: string): string | null {
	for (const name of ONECODE_NAMES) {
		const p = join(dir, name);
		if (isFile(p)) return p;
	}
	return null;
}

/**
 * The set of file paths pulled into context by `@path` imports across the loaded
 * CLAUDE.md-family / ONECODE.md files. An `AGENTS.md` shows in the picker only if
 * it is in here — a standalone AGENTS.md that nothing imports is not part of One
 * Code's context, so editing/trimming it would not change anything.
 */
function importedPaths(cwd: string, home: string, homeClaudeDir: string, homeOneCodeDir: string): Set<string> {
	const refs = new Set<string>();
	for (const { path } of discoverContextFilePaths({ cwd, homeClaudeDir, homeOneCodeDir })) {
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		for (const p of collectImportedPaths(content, dirname(path), { home })) refs.add(p);
	}
	return refs;
}

/**
 * Display form of a path: a file at the cwd shows as `./name` (CC's "Checked in
 * at ./CLAUDE.md"), a path under home as `~/…`, else the absolute path.
 */
function displayPath(path: string, cwd: string, home: string): string {
	if (path.startsWith(`${cwd}/`)) return `./${path.slice(cwd.length + 1)}`;
	if (home && path === home) return "~";
	if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

export function buildMemoryEntries(opts: {
	cwd: string;
	home: string;
	homeClaudeDir: string;
	homeOneCodeDir: string;
	memoryDir: string;
}): MemoryEntry[] {
	const { cwd, home, homeClaudeDir, homeOneCodeDir, memoryDir } = opts;
	const entries: MemoryEntry[] = [];
	const seen = new Set<string>();
	// AGENTS.md enters context only via an @import; ONECODE.md is always loaded.
	const referenced = importedPaths(cwd, home, homeClaudeDir, homeOneCodeDir);
	const add = (entry: MemoryEntry) => {
		if (seen.has(entry.path)) return;
		entries.push(entry);
		seen.add(entry.path);
	};

	// Global user instructions — always offered, matching CC (created on save).
	const globalClaude = join(homeClaudeDir, "CLAUDE.md");
	add({
		title: "User instructions",
		description: `Saved in ${displayPath(globalClaude, cwd, home)}`,
		path: globalClaude,
		kind: "file",
		exists: isFile(globalClaude),
	});
	const globalOneCode = oneCodeIn(homeOneCodeDir);
	if (globalOneCode) {
		add({
			title: "One Code user instructions",
			description: `${displayPath(globalOneCode, cwd, home)} (One Code only)`,
			path: globalOneCode,
			kind: "file",
			exists: true,
		});
	}

	// Project tree, farthest ancestor → cwd.
	const dirs: string[] = [];
	let dir = cwd;
	while (true) {
		dirs.unshift(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	for (const d of dirs) {
		const isCwd = d === cwd;
		const claude = join(d, "CLAUDE.md");
		if (isCwd) {
			// Project instructions — always offered (created on save).
			add({
				title: "Project instructions",
				description: `Checked in at ${displayPath(claude, cwd, home)}`,
				path: claude,
				kind: "file",
				exists: isFile(claude),
			});
		} else if (isFile(claude)) {
			add({ title: displayPath(claude, cwd, home), path: claude, kind: "file", exists: true });
		}

		const local = join(d, "CLAUDE.local.md");
		if (isFile(local)) add({ title: displayPath(local, cwd, home), path: local, kind: "file", exists: true });

		const agents = join(d, "AGENTS.md");
		if (isFile(agents) && referenced.has(agents)) {
			add({
				title: isCwd ? "Agent instructions" : displayPath(agents, cwd, home),
				description: isCwd ? `Checked in at ${displayPath(agents, cwd, home)}` : undefined,
				path: agents,
				kind: "file",
				exists: true,
			});
		}

		const oneCode = oneCodeIn(d);
		if (oneCode) {
			add({
				title: isCwd ? "One Code instructions" : displayPath(oneCode, cwd, home),
				description: `${displayPath(oneCode, cwd, home)} (One Code only)`,
				path: oneCode,
				kind: "file",
				exists: true,
			});
		}
	}

	add({ title: "Open auto-memory folder", path: memoryDir, kind: "folder", exists: true });
	return entries;
}

/** The basename used in the startup size warning (e.g. `CLAUDE.md`). */
export function entryName(entry: MemoryEntry): string {
	return basename(entry.path);
}
