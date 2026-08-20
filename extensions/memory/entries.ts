/**
 * The entries shown in the `/memory` panel and checked by the startup size
 * warning — mirroring Claude Code's picker, extended to the files One Code also
 * loads. Pure (fs reads only), so ordering and labelling are unit-testable.
 *
 * The CLAUDE.md family and ONECODE.md come straight from `discoverContextFilePaths`
 * (the single source of truth for "what's loaded into context"), so this never
 * re-derives discovery or drifts from it. Layered on top, for the picker only:
 * the two always-offered primaries (global + project `CLAUDE.md`, created on
 * save), AGENTS.md **when a loaded file `@`-imports it** (a standalone AGENTS.md
 * is not in our context, so trimming it changes nothing — CC has no AGENTS.md
 * concept at all), and the auto-memory folder as the last entry.
 */

import { basename, dirname, join } from "node:path";
import {
	AGENTS_DESCRIPTOR,
	ancestorDirs,
	collectImportedPaths,
	type ContextFilePath,
	discoverContextFilePaths,
	GLOBAL_DESCRIPTOR,
	LOCAL_DESCRIPTOR,
	ONECODE_DESCRIPTOR,
	ONECODE_GLOBAL_DESCRIPTOR,
	PROJECT_DESCRIPTOR,
} from "../lib/claude-context.ts";
import { tryReadFile } from "../lib/plugins.ts";

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

/** Display form of a path: a file at the cwd as `./name`, under home as `~/…`, else absolute. */
function displayPath(path: string, cwd: string, home: string): string {
	if (path.startsWith(`${cwd}/`)) return `./${path.slice(cwd.length + 1)}`;
	if (home && path === home) return "~";
	if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

/**
 * The paths pulled into context by `@path` imports across the already-discovered
 * context files (read once each). An AGENTS.md shows only if it is in here.
 */
function referencedImports(discovered: ContextFilePath[], home: string): Set<string> {
	const refs = new Set<string>();
	for (const { path } of discovered) {
		const content = tryReadFile(path);
		if (content === undefined) continue;
		for (const p of collectImportedPaths(content, dirname(path), { home })) refs.add(p);
	}
	return refs;
}

export function buildMemoryEntries(opts: {
	cwd: string;
	home: string;
	homeClaudeDir: string;
	homeOneCodeDir: string;
	memoryDir: string;
}): MemoryEntry[] {
	const { cwd, home, homeClaudeDir, homeOneCodeDir, memoryDir } = opts;
	// agentsFallback so a directory's AGENTS.md (when it has no CLAUDE.md) is in the
	// list, matching what the # claudeMd block sends.
	const discovered = discoverContextFilePaths({ cwd, homeClaudeDir, homeOneCodeDir, agentsFallback: true });
	const referenced = referencedImports(discovered, home);
	// (descriptor, dir) → the discovered path, so per-dir lookups reuse the real
	// on-disk casing discovery already resolved (no second stat/readdir here).
	const found = new Map<string, string>();
	for (const { path, descriptor } of discovered) found.set(`${descriptor}\0${dirname(path)}`, path);

	const entries: MemoryEntry[] = [];
	const seen = new Set<string>();
	const add = (entry: MemoryEntry) => {
		if (seen.has(entry.path)) return;
		entries.push(entry);
		seen.add(entry.path);
	};
	const disp = (path: string) => displayPath(path, cwd, home);

	// Global user instructions — always offered, matching CC (created on save).
	const globalClaude = join(homeClaudeDir, "CLAUDE.md");
	add({
		title: "User instructions",
		description: `Saved in ${disp(globalClaude)}`,
		path: globalClaude,
		kind: "file",
		exists: found.has(`${GLOBAL_DESCRIPTOR}\0${homeClaudeDir}`),
	});
	const globalOneCode = found.get(`${ONECODE_GLOBAL_DESCRIPTOR}\0${homeOneCodeDir}`);
	if (globalOneCode) {
		add({
			title: "One Code user instructions",
			description: `${disp(globalOneCode)} (One Code only)`,
			path: globalOneCode,
			kind: "file",
			exists: true,
		});
	}

	for (const d of ancestorDirs(cwd)) {
		const isCwd = d === cwd;
		const claude = join(d, "CLAUDE.md");
		if (isCwd) {
			// Project instructions — always offered (created on save).
			add({
				title: "Project instructions",
				description: `Checked in at ${disp(claude)}`,
				path: claude,
				kind: "file",
				exists: found.has(`${PROJECT_DESCRIPTOR}\0${d}`),
			});
		} else if (found.has(`${PROJECT_DESCRIPTOR}\0${d}`)) {
			add({ title: disp(claude), path: claude, kind: "file", exists: true });
		}

		if (found.has(`${LOCAL_DESCRIPTOR}\0${d}`)) {
			const local = join(d, "CLAUDE.local.md");
			add({ title: disp(local), path: local, kind: "file", exists: true });
		}

		// AGENTS.md is editable when it's in context: the CLAUDE.md fallback for this
		// directory (in `found`), or `@`-imported into a CLAUDE.md/ONECODE.md.
		const agents = join(d, "AGENTS.md");
		if (found.has(`${AGENTS_DESCRIPTOR}\0${d}`) || referenced.has(agents)) {
			add({
				title: isCwd ? "Agent instructions" : disp(agents),
				description: isCwd ? `Checked in at ${disp(agents)}` : undefined,
				path: agents,
				kind: "file",
				exists: true,
			});
		}

		const oneCode = found.get(`${ONECODE_DESCRIPTOR}\0${d}`);
		if (oneCode) {
			add({
				title: isCwd ? "One Code instructions" : disp(oneCode),
				description: `${disp(oneCode)} (One Code only)`,
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
