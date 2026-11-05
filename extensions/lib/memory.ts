/**
 * Claude Code-style auto-memory: a per-project directory of one-fact-per-file
 * markdown memories plus a MEMORY.md index that is loaded into context each
 * session. The model itself reads and writes the files with the ordinary file
 * tools — the harness only guarantees the directory exists, describes the
 * format in the system prompt, and injects the index on the first turn.
 *
 * Pure path/text helpers live here; `extensions/memory` does the filesystem
 * wiring and `extensions/system-prompt` embeds the prompt section. Both
 * re-derive paths from (home, cwd) rather than sharing state, since jiti gives
 * each extension its own module instance.
 *
 * What is NOT replicated: Claude Code's relevance-based recall of individual
 * memories mid-session. Its selection mechanism is undocumented client
 * internals, and no recalled-memory block appears in either captured context
 * we have — the index is the entry point; the model follows links from there.
 */

import os from "node:os";
import { join } from "node:path";
import { userConfigDir } from "./config-mode.ts";
import { findProjectRoot } from "./git.ts";

/** Claude Code's project-directory slug: 200 sanitized characters, then a hash for longer paths. */
export function projectSlug(projectRoot: string): string {
	const slug = projectRoot.replace(/[^A-Za-z0-9-]/g, "-");
	if (slug.length <= 200) return slug;

	let hash = 0;
	for (let i = 0; i < projectRoot.length; i++) {
		hash = ((hash << 5) - hash + projectRoot.charCodeAt(i)) | 0;
	}
	return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * `~/.claude/projects/<slug>/memory` — the same location Claude Code uses —
 * or, in independent mode (lib/config-mode.ts), `~/.onecode/projects/<slug>/memory`.
 * `projectRoot` must be the git repository root when there is one (all
 * worktrees and subdirectories share one memory directory), else the cwd.
 */
export function memoryDir(home: string, projectRoot: string): string {
	return join(userConfigDir(home), "projects", projectSlug(projectRoot), "memory");
}

/**
 * `memoryDir` composed with the actual project-root resolution every caller
 * needs: the git repository root when there is one — a linked worktree
 * (including a subagent's isolation worktree) resolves to its main checkout, so
 * worktrees and subdirectories share one directory — else `cwd` itself. `home`
 * defaults to `os.homedir()`.
 */
export function projectMemoryDir(cwd: string, home: string = os.homedir()): string {
	return memoryDir(home, findProjectRoot(cwd) ?? cwd);
}

/**
 * Claude Code's soft size limit for a context file (CLAUDE.md/AGENTS.md/ONECODE.md):
 * over ~40k chars it warns at startup that the file is bloating the context, and
 * points at `/memory` to trim it. Distinct from the MEMORY.md *index* load limit
 * above — this is about the instruction files the model reads every turn.
 */
export const CLAUDE_MD_CHAR_LIMIT = 40_000;

/**
 * CC's over-limit warning for a context file, or null when within the limit.
 * `name` is the file's basename (e.g. `CLAUDE.md`); `chars` is its length. The
 * `N.Nk` rendering matches CC's "over the 40.0k-char limit (55.4k chars)".
 */
export function claudeMdLimitWarning(name: string, chars: number): string | null {
	if (chars <= CLAUDE_MD_CHAR_LIMIT) return null;
	const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
	return `${name} is over the ${k(CLAUDE_MD_CHAR_LIMIT)}-char limit (${k(chars)} chars) · /memory to free up context`;
}

/**
 * The combined-size warning: when several instruction files each fit but together
 * blow the budget. `totalChars` is the sum across every instruction file One Code
 * sends (CLAUDE.md family / AGENTS.md fallback / ONECODE.md). Returns null within
 * the limit. The caller suppresses this when a single file already tripped
 * `claudeMdLimitWarning`, so a lone bloated file is named once, not twice.
 */
export function combinedLimitWarning(totalChars: number): string | null {
	if (totalChars <= CLAUDE_MD_CHAR_LIMIT) return null;
	const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
	return `Project instructions total ${k(totalChars)} chars, over the ${k(CLAUDE_MD_CHAR_LIMIT)}-char limit · /memory to free up context`;
}
