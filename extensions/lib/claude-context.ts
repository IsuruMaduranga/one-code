/**
 * Claude Code's `# claudeMd` context block — the single `<system-reminder>` that
 * carries the CLAUDE.md files, the MEMORY.md index, the user's email, and the
 * date, prepended to the first user message (see extensions/claude-context for
 * the wiring, and lib/reminders.ts for placement).
 *
 * This module is pure (no pi imports) and byte-exact against real Claude Code
 * captures (opus-4-8.json / latest-haiku.json). The block is identical across
 * model tiers — only the `# Memory` *spec* in the system prompt varies by tier
 * (handled in lib/memory.ts), never this block.
 *
 * Discovery mirrors Claude Code, not pi's own loader: global `~/.claude/CLAUDE.md`
 * first, then project `CLAUDE.md` / `CLAUDE.local.md` from the farthest ancestor
 * down to the cwd. (pi's resource-loader prefers AGENTS.md over CLAUDE.md per
 * dir and omits CLAUDE.local.md / MEMORY.md, so it can't produce these bytes.)
 *
 * What is NOT yet replicated: enterprise-policy files and nested subtree
 * CLAUDE.md loaded on-demand when a file under them is read (a follow-up needing
 * file-tracker integration; absent from every turn-1 capture we have).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** One CLAUDE.md-family file as it appears in the block. `content` is raw (untrimmed). */
export interface ContextFile {
	path: string;
	content: string;
	descriptor: string;
}

export const GLOBAL_DESCRIPTOR = "user's private global instructions for all projects";
export const PROJECT_DESCRIPTOR = "project instructions, checked into the codebase";
export const LOCAL_DESCRIPTOR = "user's private project instructions, not checked in";
export const MEMORY_DESCRIPTOR = "user's auto-memory, persists across conversations";

const PREAMBLE =
	"As you answer the user's questions, you can use the following context:\n" +
	"# claudeMd\n" +
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. " +
	"IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

const TRAILER =
	"      IMPORTANT: this context may or may not be relevant to your tasks. " +
	"You should not respond to this context unless it is highly relevant to your task.";

function readFileIfPresent(path: string): string | null {
	try {
		if (!existsSync(path) || !statSync(path).isFile()) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Claude Code's CLAUDE.md discovery, ordered as it appears in the block: global
 * first, then project files from the farthest ancestor down to the cwd. Within a
 * directory, `CLAUDE.md` then `CLAUDE.local.md`. `homeClaudeDir` is `~/.claude`.
 */
export function discoverContextFiles(opts: {
	cwd: string;
	homeClaudeDir: string;
}): ContextFile[] {
	const files: ContextFile[] = [];
	const seen = new Set<string>();

	const globalPath = join(opts.homeClaudeDir, "CLAUDE.md");
	const globalContent = readFileIfPresent(globalPath);
	if (globalContent !== null) {
		files.push({ path: globalPath, content: globalContent, descriptor: GLOBAL_DESCRIPTOR });
		seen.add(globalPath);
	}

	// Walk cwd → root collecting directories, then emit farthest-ancestor first.
	const dirs: string[] = [];
	let dir = opts.cwd;
	while (true) {
		dirs.unshift(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	for (const d of dirs) {
		for (const [name, descriptor] of [
			["CLAUDE.md", PROJECT_DESCRIPTOR],
			["CLAUDE.local.md", LOCAL_DESCRIPTOR],
		] as const) {
			const p = join(d, name);
			if (seen.has(p)) continue;
			const content = readFileIfPresent(p);
			if (content !== null) {
				files.push({ path: p, content, descriptor });
				seen.add(p);
			}
		}
	}

	return files;
}

/**
 * Assemble the block's inner text (the `<system-reminder>` wrapper is added by
 * lib/reminders.ts). Byte-exact rule reverse-engineered from opus-4-8.json:
 *
 *   {PREAMBLE}\n\n
 *   {section}\n{section}\n…            ← sections joined by a single "\n"
 *   # userEmail\nThe user's email address is {email}.\n
 *   # currentDate\nToday's date is {date}.\n
 *   \n{TRAILER}
 *
 * where each section is `Contents of {path} ({descriptor}):\n\n{content}` and
 * `content` keeps its own trailing newline (files are read raw, never trimmed —
 * a file ending in "\n" plus the join "\n" is the "\n\n" seen between sections;
 * the last section's own trailing "\n" is the single "\n" before `# userEmail`).
 *
 * `memoryIndex`, when present, is appended as a final context section with the
 * memory descriptor. Returns null when there is nothing at all to inject.
 */
export function buildClaudeMdBlock(opts: {
	contextFiles: ContextFile[];
	memoryIndex?: { path: string; content: string } | null;
	email?: string | null;
	date: string;
}): string | null {
	const sections = [...opts.contextFiles];
	if (opts.memoryIndex && opts.memoryIndex.content.trim()) {
		sections.push({
			path: opts.memoryIndex.path,
			content: opts.memoryIndex.content,
			descriptor: MEMORY_DESCRIPTOR,
		});
	}

	if (sections.length === 0 && !opts.email) return null;

	let inner = `${PREAMBLE}\n\n`;
	inner += sections.map((s) => `Contents of ${s.path} (${s.descriptor}):\n\n${s.content}`).join("\n");
	if (opts.email) {
		inner += `# userEmail\nThe user's email address is ${opts.email}.\n`;
	}
	inner += `# currentDate\nToday's date is ${opts.date}.\n`;
	inner += `\n${TRAILER}`;
	return inner;
}
