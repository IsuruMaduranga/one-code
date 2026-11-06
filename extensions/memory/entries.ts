/**
 * The entries shown in the `/memory` panel and checked by the startup size
 * warning — mirroring Claude Code's picker, extended to the files One Code also
 * loads. Pure (fs reads only), so ordering and labelling are unit-testable.
 *
 * The instruction files come straight from `openInstructions().paths`
 * (lib/instructions.ts and the profile's provider: the single source of truth
 * for "what's loaded into context"), so this never
 * re-derives discovery or drifts from it. Layered on top, for the picker only:
 * the two always-offered primaries (the instruction targets: global + project
 * `CLAUDE.md`, or `ONECODE.md` and `AGENTS.md` without a provider, created on
 * save), AGENTS.md **when a loaded file `@`-imports it** (a standalone AGENTS.md
 * is not in our context, so trimming it changes nothing — CC has no AGENTS.md
 * concept at all), and the auto-memory folder as the last entry.
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import {
	AGENTS_DESCRIPTOR,
	AGENTS_GLOBAL_DESCRIPTOR,
	ancestorDirs,
	collectImportedPaths,
	type ContextFilePath,
	instructionTargets,
	LOCAL_DESCRIPTOR,
	ONECODE_DESCRIPTOR,
	ONECODE_GLOBAL_DESCRIPTOR,
	openInstructions,
	PROJECT_DESCRIPTOR,
} from "../lib/instructions.ts";
import { forwardSlashes, isRelativeInside, tildify } from "../lib/paths.ts";
import { projectConfigDirName } from "../lib/sources.ts";
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

/**
 * Display form of a path: a file under the cwd as `./name`, under home as
 * `~/…`, else as given — always with forward slashes (Claude Code's spelling
 * in this picker), whatever the platform's separator.
 */
function displayPath(path: string, cwd: string, home: string): string {
	const rel = relative(resolve(cwd), resolve(path));
	return isRelativeInside(rel) ? `./${forwardSlashes(rel)}` : tildify(path, home);
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
	homeOneCodeDir: string;
	/** pi's agent dir (`getAgentDir()`), for its global AGENTS.md. */
	agentDir: string | undefined;
	/** The auto-memory folder; undefined while auto-memory is off (no folder row, as in Claude Code). */
	memoryDir: string | undefined;
}): MemoryEntry[] {
	const { cwd, home, homeOneCodeDir, agentDir, memoryDir } = opts;
	// The always-offered rows are the files a user writes: CLAUDE.md with One
	// Code's provider on, the global ONECODE.md and the project's AGENTS.md
	// without it (lib/instructions.ts instructionTargets).
	const targets = instructionTargets(home, homeOneCodeDir);
	// The same files the # claudeMd block takes, so the list matches what it sends.
	const discovered = openInstructions(home, agentDir).paths({ cwd, homeOneCodeDir });
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
	const globalOneCode = found.get(`${ONECODE_GLOBAL_DESCRIPTOR}\0${homeOneCodeDir}`);
	const discoveredPaths = new Set(discovered.map(({ path }) => path));
	add({
		title: "User instructions",
		description: `Saved in ${disp(targets.user)}`,
		path: targets.user,
		kind: "file",
		exists: discoveredPaths.has(targets.user),
	});
	if (globalOneCode) {
		add({
			title: "One Code user instructions",
			description: `${disp(globalOneCode)} (One Code only)`,
			path: globalOneCode,
			kind: "file",
			exists: true,
		});
	}
	// The user's global AGENTS.md files the agent reads (pi's and ~/.agents/AGENTS.md), when it reads them.
	for (const { path, descriptor } of discovered) {
		if (descriptor === AGENTS_GLOBAL_DESCRIPTOR) add({ title: "Global AGENTS.md", description: `${disp(path)} (cross-tool)`, path, kind: "file", exists: true });
	}

	const configDir = projectConfigDirName();
	for (const d of ancestorDirs(cwd)) {
		const isCwd = d === cwd;
		if (isCwd) {
			// Project instructions, always offered (created on save).
			const project = join(d, targets.project);
			add({
				title: "Project instructions",
				description: `Checked in at ${disp(project)}`,
				path: project,
				kind: "file",
				exists: discoveredPaths.has(project),
			});
		} else {
			// A provider's project file in an ancestor directory, as discovery found it.
			const project = found.get(`${PROJECT_DESCRIPTOR}\0${d}`);
			if (project) add({ title: disp(project), path: project, kind: "file", exists: true });
		}

		const local = found.get(`${LOCAL_DESCRIPTOR}\0${d}`);
		if (local) add({ title: disp(local), path: local, kind: "file", exists: true });

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
		// An AGENTS.md in the project's config folder (`.claude/AGENTS.md`), which a provider may load too.
		const configAgents = found.get(`${AGENTS_DESCRIPTOR}\0${join(d, configDir)}`);
		if (configAgents) add({ title: disp(configAgents), path: configAgents, kind: "file", exists: true });

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

	if (memoryDir) add({ title: "Open auto-memory folder", path: memoryDir, kind: "folder", exists: true });
	return entries;
}

/** The basename used in the startup size warning (e.g. `CLAUDE.md`). */
export function entryName(entry: MemoryEntry): string {
	return basename(entry.path);
}
