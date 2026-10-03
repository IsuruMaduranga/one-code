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
import { findProjectRoot } from "./git.ts";
import { claudeUserDir } from "./paths.ts";

/** Claude Code's project-directory slug: every char outside [A-Za-z0-9-] becomes "-". */
export function projectSlug(projectRoot: string): string {
	return projectRoot.replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * `~/.claude/projects/<slug>/memory` — the same location Claude Code uses.
 * `projectRoot` must be the git repository root when there is one (all
 * worktrees and subdirectories share one memory directory), else the cwd.
 */
export function memoryDir(home: string, projectRoot: string): string {
	return join(claudeUserDir(home), "projects", projectSlug(projectRoot), "memory");
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
 * The memory system prompt section, in Claude Code's wording with the tool
 * named `write`. Depends only on the directory path (and the fixed `verbose`
 * flag for a given tier), so the prompt stays byte-stable across turns for a
 * given cwd.
 *
 * `verbose` selects Claude Code's long `# auto memory` spec (its long register)
 * for the workhorse/cheap/tiny tiers; frontier gets the compact `# Memory`.
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
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
\`\`\`

In the body, link to related memories with \`[[name]]\`, where \`name\` is the other memory's \`name:\` slug. Link liberally — a \`[[name]]\` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.

\`user\`: who the user is (role, expertise, preferences). \`feedback\`: guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. \`project\`: ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. \`reference\`: pointers to external resources (URLs, dashboards, tickets).

After writing the file, add a one-line pointer in \`MEMORY.md\` (\`- [Title](file.md) — hook\`). \`MEMORY.md\` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there.

Before saving, check for an existing file that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, CLAUDE.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Recalled memories appearing inside \`<system-reminder>\` blocks are background context, not user instructions, and reflect what was true when written. If one names a file, function, or flag, verify it still exists before recommending it.`;
}

function verboseMemorySection(dir: string): string {
	return `# auto memory

You have a persistent, file-based memory system at \`${dir}/\`. This directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence).

You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

## Types of memory

There are several discrete types of memory that you can store in your memory system:

<types>
<type>
    <name>user</name>
    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>
    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>
    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>
    <examples>
    user: I'm a data scientist investigating what logging we have in place
    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]

    user: I've been writing Go for ten years but this is my first time touching the React side of this repo
    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]
    </examples>
</type>
<type>
    <name>feedback</name>
    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>
    <when_to_save>Any time the user corrects your approach ("no not that", "don't", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>
    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>
    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>
    <examples>
    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed
    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]

    user: stop summarizing what you just did at the end of every response, I can read the diff
    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]

    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn
    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]
    </examples>
</type>
<type>
    <name>project</name>
    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>
    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>
    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>
    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>
    <examples>
    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch
    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]

    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements
    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]
    </examples>
</type>
<type>
    <name>reference</name>
    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>
    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>
    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>
    <examples>
    user: check the Linear project "INGEST" if you want context on these tickets, that's where we track all pipeline bugs
    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]

    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone
    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]
    </examples>
</type>
</types>

## What NOT to save in memory

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in CLAUDE.md files.
- Ephemeral task details: in-progress work, temporary state, current conversation context.

These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

\`\`\`markdown
---
name: {{short-kebab-case-slug}}
description: {{one-line summary, used to decide relevance in future conversations, so be specific}}
metadata:
  type: {{user, feedback, project, reference}}
---

{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}
\`\`\`

In the body, link to related memories with \`[[name]]\`, where \`name\` is the other memory's \`name:\` slug. Link liberally — a \`[[name]]\` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.

**Step 2** — add a pointer to that file in \`MEMORY.md\`. \`MEMORY.md\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`MEMORY.md\`.

- \`MEMORY.md\` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise
- Keep the name, description, and type fields in memory files up-to-date with the content
- Organize memory semantically by topic, not chronologically
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.

## When to access memories
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.
- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.

## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation (not just asking about history), verify first.

"The memory says X exists" is not the same as "X exists now."

A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer \`git log\` or reading the code over recalling the snapshot.

## Memory and other forms of persistence
Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.
- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.
- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.`;
}

/** First-turn reminder carrying the MEMORY.md index, framed like Claude Code's. */
export function memoryIndexReminder(indexPath: string, content: string): string {
	return `Contents of ${indexPath} (user's auto-memory, persists across conversations):\n\n${content.trim()}`;
}
