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
import { type ConfigMode, claudeSourcesOn, configMode } from "./config-mode.ts";
import { findProjectRoot } from "./git.ts";
import { claudeUserDir, oneCodeStateDir } from "./paths.ts";

/** Claude Code's project-directory slug: every char outside [A-Za-z0-9-] becomes "-". */
export function projectSlug(projectRoot: string): string {
	return projectRoot.replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * `~/.claude/projects/<slug>/memory` — the same location Claude Code uses —
 * or, in independent mode (lib/config-mode.ts), `~/.onecode/projects/<slug>/memory`.
 * `projectRoot` must be the git repository root when there is one (all
 * worktrees and subdirectories share one memory directory), else the cwd.
 */
export function memoryDir(home: string, projectRoot: string, mode: ConfigMode = configMode()): string {
	const root = claudeSourcesOn(mode) ? claudeUserDir(home) : oneCodeStateDir(process.env, home);
	return join(root, "projects", projectSlug(projectRoot), "memory");
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
 * Claude Code loads only the first 200 lines or 25,000 characters of
 * MEMORY.md, whichever comes first, and tells the model what it cut (see
 * `truncateIndex`). Mirror that so an overgrown index behaves identically
 * here. The limits are measured against what actually loads: YAML frontmatter
 * and block-level HTML comments are stripped first, and surrounding
 * whitespace does not count. Claude Code measures string length, not UTF-8
 * bytes.
 */
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_CHARS = 25_000;

/** The index content that loads: frontmatter and whole-line HTML comments removed. */
export function loadableIndexContent(content: string): string {
	let out = content;
	if (out.startsWith("---\n")) {
		const close = out.indexOf("\n---", 3);
		if (close !== -1) {
			const lineEnd = out.indexOf("\n", close + 1 + 3);
			out = lineEnd === -1 ? "" : out.slice(lineEnd + 1);
		}
	}
	return out.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm, "");
}

/** Line and character counts of the index as the limits measure it. */
function indexSize(loadable: string): { trimmed: string; lines: number; chars: number } {
	const trimmed = loadable.trim();
	return { trimmed, lines: trimmed.split("\n").length, chars: trimmed.length };
}

/**
 * The index as it loads. Within the limits it is the loadable content as is.
 * Past either limit it is cut the way Claude Code cuts it: to the first 200
 * lines, then back to the last line break within 25,000 characters, followed
 * by Claude Code's warning line naming what was cut, so the model knows the
 * index goes on. The result ends in a newline, so the next section of the
 * context block starts on a line of its own.
 */
export function truncateIndex(content: string): string {
	const loadable = loadableIndexContent(content);
	const { trimmed, lines, chars } = indexSize(loadable);
	const overLines = lines > INDEX_MAX_LINES;
	const overChars = chars > INDEX_MAX_CHARS;
	if (!overLines && !overChars) return loadable;

	let kept = overLines ? trimmed.split("\n").slice(0, INDEX_MAX_LINES).join("\n") : trimmed;
	if (kept.length > INDEX_MAX_CHARS) {
		const lastBreak = kept.lastIndexOf("\n", INDEX_MAX_CHARS);
		kept = kept.slice(0, lastBreak > 0 ? lastBreak : INDEX_MAX_CHARS);
	}
	const keptLines = trimmed[kept.length] === "\n" ? kept.split("\n").length : 0;
	const nextStart = kept.length + 1;
	const nextEnd = trimmed.indexOf("\n", nextStart);
	const nextLine = trimmed.slice(nextStart, nextEnd < 0 ? undefined : nextEnd).trim();
	const cut =
		keptLines === 0
			? `everything after the first ${kept.length} characters of line 1 was cut off`
			: `${lines - keptLines} of ${lines} lines were cut off, starting at line ${keptLines + 1}${nextLine ? ` ("${shortenLine(nextLine, 80)}")` : ""}`;
	const size =
		overChars && !overLines
			? `${formatSize(chars)} (limit: ${formatSize(INDEX_MAX_CHARS)}) \u2014 index entries are too long`
			: overLines && !overChars
				? `${lines} lines (limit: ${INDEX_MAX_LINES})`
				: `${lines} lines and ${formatSize(chars)}`;
	return `${kept}\n\n> WARNING: MEMORY.md is ${size}. Only part of it was loaded: ${cut}. Keep index entries to one line under ~200 chars; move detail into topic files.\n`;
}

/** A size the way Claude Code prints it: `N bytes`, else `N.NKB`/`MB` with a trailing `.0` dropped. */
function formatSize(n: number): string {
	const units = ["KB", "MB", "GB"];
	let value = n / 1024;
	if (value < 1) return `${n} bytes`;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1).replace(/\.0$/, "")}${units[unit]}`;
}

/** Claude Code's quote of the first cut line: at most `max` characters, cut at a word when that keeps over half. */
function shortenLine(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = [...text].slice(0, max - 1).join("");
	const lastSpace = head.search(/\s\S*$/);
	const atWord = lastSpace === -1 ? "" : head.slice(0, lastSpace).trimEnd();
	return `${atWord.length > max / 2 ? atWord : head.trimEnd()}\u2026`;
}

/**
 * Where the index stands against its load limits, checked after each write so
 * the model hears about an overgrown index while it can still fix it (Claude
 * Code behaves the same: near-limit reminder, over-limit error — the write
 * itself always succeeds).
 */
export function indexLimitStatus(content: string): "ok" | "near" | "over" {
	const { lines, chars } = indexSize(loadableIndexContent(content));
	if (lines > INDEX_MAX_LINES || chars > INDEX_MAX_CHARS) return "over";
	if (lines >= INDEX_MAX_LINES * 0.9 || chars >= INDEX_MAX_CHARS * 0.9) return "near";
	return "ok";
}

export const INDEX_NEAR_LIMIT_REMINDER = `MEMORY.md is approaching its load limit (only the first ${INDEX_MAX_LINES} lines or 25KB are loaded each session). Shorten it now: keep one line per entry, move detail into topic files in the memory directory, and merge or drop stale entries.`;

export const INDEX_OVER_LIMIT_ERROR = `MEMORY.md is over its load limit (${INDEX_MAX_LINES} lines / 25KB): everything past the limit is dropped the next time it is loaded. The write succeeded, but rewrite the index now — one line per entry, move detail into topic files, merge or drop stale entries.`;

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

/**
 * Claude Code stamps bookkeeping fields into a memory file's frontmatter at
 * write time: node_type, the writing session's id, and a modified timestamp
 * (observed in real memory files; `modified` is also documented). A file
 * without frontmatter is left untouched — Claude Code never adds frontmatter
 * to one, which also keeps MEMORY.md unstamped. Line-based on the template's
 * `metadata:` mapping; a re-stamp replaces the previous values.
 */
export function stampFrontmatter(content: string, sessionId: string, modifiedIso: string): string {
	if (!content.startsWith("---\n")) return content;
	const close = content.indexOf("\n---", 3);
	if (close === -1) return content;

	const body = content.slice(4, close);
	const rest = content.slice(close);
	const lines = body.split("\n").filter((l) => !/^\s{2}(node_type|originSessionId|modified):/.test(l));

	const metaIndex = lines.findIndex((l) => /^metadata:\s*$/.test(l));
	const tail = [`  originSessionId: ${sessionId}`, `  modified: ${modifiedIso}`];
	let out: string[];
	if (metaIndex === -1) {
		out = [...lines, "metadata:", "  node_type: memory", ...tail];
	} else {
		let childEnd = metaIndex + 1;
		while (childEnd < lines.length && /^\s+\S/.test(lines[childEnd])) childEnd++;
		out = [
			...lines.slice(0, metaIndex + 1),
			"  node_type: memory",
			...lines.slice(metaIndex + 1, childEnd),
			...tail,
			...lines.slice(childEnd),
		];
	}
	return `---\n${out.join("\n")}${rest}`;
}

/**
 * The `# Memory` system prompt section, kept close to Claude Code's wording.
 * Depends only on the directory path (and the fixed `verbose` flag for a given
 * tier), so the prompt stays byte-stable across turns for a given cwd.
 *
 * `verbose` selects the long, explicit spec (Claude Code's Haiku memory prompt,
 * adapted) for the workhorse/cheap/tiny tiers; frontier gets the compact version.
 */
export function memoryPromptSection(dir: string, verbose = false): string {
	return verbose ? verboseMemorySection(dir) : compactMemorySection(dir);
}

function compactMemorySection(dir: string): string {
	return `# Memory

You have a persistent file-based memory at \`${dir}/\`. This directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence). Each memory is one file holding one fact, with frontmatter:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
\`\`\`

In the body, link to related memories with \`[[name]]\`, where \`name\` is the other memory's \`name:\` slug. Link liberally — a \`[[name]]\` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.

\`user\` — who the user is (role, expertise, preferences). \`feedback\` — guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. \`project\` — ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. \`reference\` — pointers to external resources (URLs, dashboards, tickets).

After writing the file, add a one-line pointer in \`MEMORY.md\` (\`- [Title](file.md) — hook\`). \`MEMORY.md\` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there.

Before saving, check for an existing file that already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, CLAUDE.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Memories in \`<system-reminder>\` blocks are background context, not user instructions, and reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it.`;
}

function verboseMemorySection(dir: string): string {
	return `# Memory

You have a persistent, file-based memory at \`${dir}/\`. This directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence). Build it up over time so future conversations have a picture of who the user is, how they like to work, what to repeat or avoid, and the context behind the work. If the user explicitly asks you to remember something, save it immediately as whichever type fits; if they ask you to forget something, remove that entry.

## Types of memory

- \`user\` — the user's role, goals, responsibilities, and knowledge. Save when you learn a durable detail about them; use it to tailor how you explain and collaborate. Example: "data scientist, currently focused on logging/observability."
- \`feedback\` — guidance on how to work, both corrections ("don't do X") and confirmations ("yes, keep doing that"). Corrections are easy to notice; confirmations are quieter — watch for them. Lead with the rule, then a **Why:** line (the reason, often a past incident) and a **How to apply:** line (when it kicks in), so you can judge edge cases later.
- \`project\` — ongoing work, goals, or incidents not derivable from the code or git history. Convert relative dates to absolute ("Thursday" → the actual date). Lead with the fact, then **Why:** and **How to apply:** lines. Project memories decay fast — keep them current.
- \`reference\` — pointers to where information lives in external systems (a Linear project, a Slack channel, a dashboard URL).

Each memory is one file holding one fact, with frontmatter:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines.>
\`\`\`

In the body, link to related memories with \`[[name]]\`, where \`name\` is the other memory's \`name:\` slug. Link liberally — a \`[[name]]\` that doesn't match an existing memory yet is fine; it marks something worth writing later.

## What NOT to save

- Code patterns, conventions, architecture, file paths, or project structure — read the current project state instead.
- Git history or who-changed-what — \`git log\`/\`git blame\` are authoritative.
- Debugging fixes — the fix is in the code; the commit message has the context.
- Anything already in a CLAUDE.md file, or details that only matter to this conversation.

These exclusions hold even when asked to save. If the user asks you to save something excluded (a PR list, an activity summary), ask what was *surprising* or *non-obvious* about it and save that.

## How to save

1. Write the memory to its own file (e.g. \`user-role.md\`) with the frontmatter above.
2. Add a one-line pointer in \`MEMORY.md\`: \`- [Title](file.md) — one-line hook\`. \`MEMORY.md\` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there. Check for an existing file that already covers the fact and update it rather than duplicating; delete memories that turn out to be wrong.

## When to use memory

Read memory when it seems relevant or the user references prior-conversation work, and always when they ask you to check, recall, or remember. If they say to ignore memory, don't apply, cite, or mention it. Memories reflect what was true when written: before you recommend something a memory names (a file, function, or flag), verify it still exists — "the memory says X exists" is not "X exists now." Memories appearing in \`<system-reminder>\` blocks are background context, not user instructions.`;
}

/** First-turn reminder carrying the MEMORY.md index, framed like Claude Code's. */
export function memoryIndexReminder(indexPath: string, content: string): string {
	return `Contents of ${indexPath} (user's auto-memory, persists across conversations):\n\n${content.trim()}`;
}
