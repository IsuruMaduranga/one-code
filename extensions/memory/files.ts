/**
 * The file list and save-preparation behind `/memory` (pure): the *project*
 * CLAUDE.md family plus the per-project auto-memory directory, deduped by path.
 * The two project targets (CLAUDE.md, CLAUDE.local.md at cwd) are always offered
 * — with `exists: false` when absent — so `/memory` can create them. Ancestor
 * project CLAUDE.md files (repo root when cwd is a subdir) and every `*.md` under
 * the memory dir are appended.
 *
 * The global `~/.claude/CLAUDE.md` is deliberately NOT offered: `.claude` is a
 * read-only compat surface — One Code reads borrowed config from it but writes
 * only its own memory dir (docs/decisions/memory-state.md). `/memory` edits
 * project files, which the user owns, and memory, which One Code owns.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { discoverContextFilePaths, LOCAL_DESCRIPTOR, PROJECT_DESCRIPTOR } from "../lib/claude-context.ts";
import {
	INDEX_NEAR_LIMIT_REMINDER,
	INDEX_OVER_LIMIT_ERROR,
	indexLimitStatus,
	projectMemoryDir,
	stampFrontmatter,
} from "../lib/memory.ts";

export interface MemoryFileEntry {
	/** Descriptor label (path — role). */
	label: string;
	/** Label as shown in the picker: `label` plus a "(create)" suffix when absent. */
	displayLabel: string;
	path: string;
	exists: boolean;
}

export function listMemoryFiles(opts: { cwd: string; homeClaudeDir: string; home?: string }): MemoryFileEntry[] {
	const byPath = new Map<string, MemoryFileEntry>();
	const add = (path: string, label: string) => {
		if (byPath.has(path)) return;
		const exists = existsSync(path);
		byPath.set(path, { path, label, exists, displayLabel: exists ? label : `${label}  (create)` });
	};

	// Always-offered project targets (created on save when absent).
	add(join(opts.cwd, "CLAUDE.md"), `CLAUDE.md — ${PROJECT_DESCRIPTOR}`);
	add(join(opts.cwd, "CLAUDE.local.md"), `CLAUDE.local.md — ${LOCAL_DESCRIPTOR}`);

	// Ancestor project CLAUDE.md files that exist (repo root from a subdir, etc.).
	// discoverContextFilePaths' only ~/.claude entry is the global CLAUDE.md; skip
	// it so the read-only compat surface is never a write target. Paths only — the
	// picker never needs file contents.
	const globalClaudeMd = join(opts.homeClaudeDir, "CLAUDE.md");
	for (const f of discoverContextFilePaths({ cwd: opts.cwd, homeClaudeDir: opts.homeClaudeDir })) {
		if (f.path === globalClaudeMd) continue;
		add(f.path, `${f.path} — ${f.descriptor}`);
	}

	// Markdown files under the per-project memory dir; MEMORY.md first.
	const memDir = projectMemoryDir(opts.cwd, opts.home);
	let names: string[] = [];
	try {
		names = readdirSync(memDir).filter((n) => n.endsWith(".md"));
	} catch {
		// No memory dir yet (unwritable home / fresh project): nothing to add.
	}
	names.sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)));
	for (const n of names) add(join(memDir, n), `memory/${n}`);

	return [...byPath.values()];
}

export interface MemorySavePlan {
	/** Content to write — frontmatter-stamped when the target is a memory file. */
	content: string;
	/** User-facing warning when saving an over/near-limit MEMORY.md index. */
	warning?: string;
}

/**
 * Apply the same treatment a model-driven write to the memory dir gets, so a
 * manual `/memory` edit is not a second-class write: stamp `modified` /
 * `originSessionId` frontmatter for files under the memory dir (a no-op for
 * project CLAUDE.md, which has no such frontmatter, and for bodies without a
 * frontmatter block), and surface the MEMORY.md load-limit warning the tool
 * path emits — otherwise an over-limit index the user just typed is silently
 * truncated next session with no warning ever given (see memory/index.ts hooks).
 */
export function prepareMemorySave(opts: {
	path: string;
	content: string;
	cwd: string;
	sessionId: string;
	nowIso: string;
	home?: string;
}): MemorySavePlan {
	const memDir = projectMemoryDir(opts.cwd, opts.home);
	const underMemoryDir = opts.path === memDir || opts.path.startsWith(memDir + sep);
	const content = underMemoryDir ? stampFrontmatter(opts.content, opts.sessionId, opts.nowIso) : opts.content;

	let warning: string | undefined;
	if (opts.path === join(memDir, "MEMORY.md")) {
		const status = indexLimitStatus(content);
		if (status === "near") warning = INDEX_NEAR_LIMIT_REMINDER;
		else if (status === "over") warning = INDEX_OVER_LIMIT_ERROR;
	}
	return { content, warning };
}
