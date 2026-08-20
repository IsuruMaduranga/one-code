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
 * Two One Code additions layer on top of that Claude Code base, both no-ops when
 * unused so the block stays byte-exact for anyone who doesn't reach for them:
 *   - `@path` imports inside any context file are expanded in place, matching
 *     Claude Code (recursive, depth-capped, cycle-safe, code-span aware) — so a
 *     CLAUDE.md that just says `@AGENTS.md` reuses an existing AGENTS.md.
 *   - `ONECODE.md` / `onecode.md` / `OneCode.md` files (global `~/.one-code` +
 *     each project directory) carry One Code-specific instructions that Claude
 *     Code never reads. They ride their OWN `# oneCodeMd` block (see
 *     `buildOneCodeBlock` / `discoverOneCodeFiles`), emitted after the `# claudeMd`
 *     block so they take precedence over CLAUDE.md — keeping `# claudeMd` itself
 *     byte-exact with Claude Code.
 *
 * What is NOT yet replicated: enterprise-policy files and nested subtree
 * CLAUDE.md loaded on-demand when a file under them is read (a follow-up needing
 * file-tracker integration; absent from every turn-1 capture we have).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tryReadFile } from "./plugins.ts";

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
export const ONECODE_DESCRIPTOR = "One Code-specific instructions, not read by Claude Code";
export const ONECODE_GLOBAL_DESCRIPTOR =
	"One Code-specific global instructions for all projects, not read by Claude Code";

/** One Code instruction filenames, in preference order (first present per dir wins). */
const ONECODE_NAMES = ["ONECODE.md", "onecode.md", "OneCode.md"] as const;

/** Max `@import` hops, matching Claude Code. Depth 0 is the importing file itself. */
const MAX_IMPORT_DEPTH = 5;

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
	} catch {
		return null;
	}
	const content = tryReadFile(path);
	return content === undefined ? null : content;
}

/**
 * Claude Code's CLAUDE.md discovery, ordered as it appears in the block: global
 * first, then project files from the farthest ancestor down to the cwd. Within a
 * directory, `CLAUDE.md` then `CLAUDE.local.md`. `homeClaudeDir` is `~/.claude`.
 */
function isPresentFile(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * The One Code instruction file in `dir`, or null. Prefers an exact candidate
 * casing, then any case-insensitive match, and returns the file's real on-disk
 * name so `Contents of {path}` stays accurate on case-insensitive filesystems
 * (macOS), where `onecode.md` on disk would otherwise be reported as `ONECODE.md`.
 *
 * Fast path first: cheap `stat` probes of the candidate names, so the common case
 * (no One Code file in this directory — true of every ancestor up to the root)
 * costs a few stats and never lists the directory. Only when a probe hits do we
 * read the directory once to recover the real casing.
 */
function firstOneCodeFile(dir: string): string | null {
	if (!ONECODE_NAMES.some((n) => isPresentFile(join(dir, n)))) return null;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}
	const pick = ONECODE_NAMES.find((n) => entries.includes(n)) ?? entries.find((e) => e.toLowerCase() === "onecode.md");
	if (pick && isPresentFile(join(dir, pick))) return join(dir, pick);
	return null;
}

/** Resolve an `@import` reference: `~`/`~/` → home, absolute as-is, else relative to `baseDir`. */
function resolveImportPath(ref: string, baseDir: string, home: string): string {
	let p = ref;
	if (p === "~") p = home;
	else if (p.startsWith("~/")) p = join(home, p.slice(2));
	return isAbsolute(p) ? p : join(baseDir, p);
}

/**
 * Read a `@import` target, tolerating trailing sentence punctuation (`@a/b.md.`).
 * Returns the resolved path, its raw content, and any stripped trailing text to
 * re-append after the inlined content. `null` when nothing readable resolves.
 */
function readImportTarget(
	ref: string,
	baseDir: string,
	home: string,
	read: (path: string) => string | null,
	stack: Set<string>,
): { resolved: string; content: string; trailing: string } | null {
	let candidate = ref;
	for (;;) {
		const resolved = resolveImportPath(candidate, baseDir, home);
		if (!stack.has(resolved)) {
			const content = read(resolved);
			if (content !== null) return { resolved, content, trailing: ref.slice(candidate.length) };
		}
		// Not a readable file (and not a cycle already on the stack): peel one trailing
		// punctuation char and retry, so `@docs/x.md.` still resolves `docs/x.md`.
		if (candidate.length <= 1 || !/[.,;:!?)\]]$/.test(candidate)) return null;
		candidate = candidate.slice(0, -1);
	}
}

/**
 * Claude Code's `@path` imports: replace each `@path` reference with the
 * referenced file's (recursively expanded) contents. `@` inside inline-code spans
 * or fenced code blocks is left alone; a reference that does not resolve to a
 * readable file is left as literal text; cycles and hops past MAX_IMPORT_DEPTH
 * stop recursion. `read` defaults to the module's own file reader (injectable for
 * tests). A file with no importable `@` tokens is returned unchanged.
 */
export function expandImports(
	content: string,
	baseDir: string,
	opts: { home: string; read?: (path: string) => string | null },
): string {
	return expandImportsInner(content, baseDir, opts.home, opts.read ?? readFileIfPresent, new Set<string>(), 0);
}

/**
 * The absolute paths every `@path` import in `content` resolves to, transitively
 * (same traversal, resolution, cycle/depth rules as `expandImports`). Used to
 * tell whether a file — e.g. an `AGENTS.md` — is actually pulled into context,
 * rather than merely present on disk.
 */
export function collectImportedPaths(
	content: string,
	baseDir: string,
	opts: { home: string; read?: (path: string) => string | null },
): Set<string> {
	const found = new Set<string>();
	expandImportsInner(content, baseDir, opts.home, opts.read ?? readFileIfPresent, new Set<string>(), 0, (p) =>
		found.add(p),
	);
	return found;
}

function expandImportsInner(
	content: string,
	baseDir: string,
	home: string,
	read: (path: string) => string | null,
	stack: Set<string>,
	depth: number,
	onResolve?: (path: string) => void,
): string {
	if (depth >= MAX_IMPORT_DEPTH) return content;
	if (!content.includes("@")) return content;

	const out: string[] = [];
	let inFence = false;
	let fenceMarker = "";
	for (const line of content.split("\n")) {
		const fence = line.match(/^\s*(`{3,}|~{3,})/);
		if (fence) {
			const marker = fence[1][0];
			if (!inFence) {
				inFence = true;
				fenceMarker = marker;
			} else if (marker === fenceMarker) {
				inFence = false;
				fenceMarker = "";
			}
			out.push(line);
			continue;
		}
		out.push(inFence ? line : expandImportLine(line, baseDir, home, read, stack, depth, onResolve));
	}
	return out.join("\n");
}

function expandImportLine(
	line: string,
	baseDir: string,
	home: string,
	read: (path: string) => string | null,
	stack: Set<string>,
	depth: number,
	onResolve?: (path: string) => void,
): string {
	if (!line.includes("@")) return line;

	// Shield inline-code spans so `@path` inside backticks is never expanded. NUL
	// delimiters can't occur in source text, so restoration never mis-fires on a
	// real number that happens to be surrounded by spaces.
	const spans: string[] = [];
	const shielded = line.replace(/(`+)[\s\S]*?\1/g, (m) => {
		spans.push(m);
		return `\u0000${spans.length - 1}\u0000`;
	});

	const replaced = shielded.replace(/(^|\s)@(\S+)/g, (whole, lead: string, ref: string) => {
		const target = readImportTarget(ref, baseDir, home, read, stack);
		if (!target) return whole; // unresolved or cycle: leave the literal text
		onResolve?.(target.resolved);
		const next = new Set(stack);
		next.add(target.resolved);
		const expanded = expandImportsInner(target.content, dirname(target.resolved), home, read, next, depth + 1, onResolve);
		return `${lead}${expanded}${target.trailing}`;
	});

	return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)]);
}

/** A discovered CLAUDE.md-family path and its descriptor, without file content. */
export interface ContextFilePath {
	path: string;
	descriptor: string;
}

/** The cwd and each ancestor up to the filesystem root, ordered farthest-first. */
export function ancestorDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = cwd;
	while (true) {
		dirs.unshift(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

/**
 * The ordered CLAUDE.md-family paths that exist, WITHOUT reading their contents:
 * global `~/.claude/CLAUDE.md` first, then project `CLAUDE.md`/`CLAUDE.local.md`
 * from the farthest ancestor down to cwd (`CLAUDE.md` before `CLAUDE.local.md`
 * within a directory). `discoverContextFiles` reads content on top of this;
 * callers that only need paths/descriptors (e.g. `/memory`'s picker) use it
 * directly to avoid loading files they will discard.
 *
 * When `homeOneCodeDir` is given, One Code's own `ONECODE.md` files join the
 * list: the global one from `~/.one-code` right after the global CLAUDE.md, and
 * each directory's after its CLAUDE.md/CLAUDE.local.md. The `/memory` picker passes
 * it (so ONECODE.md is an editable target); the model-facing `# claudeMd` block
 * does NOT — there ONECODE.md rides its own `# oneCodeMd` block via
 * `discoverOneCodeFiles` instead, so `# claudeMd` stays byte-exact with CC.
 *
 * When `agentsFallback` is set, a directory with no `CLAUDE.md` falls back to its
 * `AGENTS.md` (CLAUDE.md > AGENTS.md — the first-match Codex/opencode do, but
 * CLAUDE-preferred for our CC-compat audience). A directory that has a CLAUDE.md
 * ignores its AGENTS.md, so `# claudeMd` stays byte-exact with CC whenever
 * CLAUDE.md is present.
 */
export function discoverContextFilePaths(opts: {
	cwd: string;
	homeClaudeDir: string;
	homeOneCodeDir?: string;
	agentsFallback?: boolean;
}): ContextFilePath[] {
	const paths: ContextFilePath[] = [];
	const seen = new Set<string>();
	const includeOneCode = opts.homeOneCodeDir !== undefined;

	/** Adds the path if present; returns whether it was added. */
	const push = (path: string, descriptor: string): boolean => {
		if (seen.has(path) || !isPresentFile(path)) return false;
		paths.push({ path, descriptor });
		seen.add(path);
		return true;
	};

	push(join(opts.homeClaudeDir, "CLAUDE.md"), GLOBAL_DESCRIPTOR);
	if (includeOneCode && opts.homeOneCodeDir) {
		const globalOneCode = firstOneCodeFile(opts.homeOneCodeDir);
		if (globalOneCode) push(globalOneCode, ONECODE_GLOBAL_DESCRIPTOR);
	}

	for (const d of ancestorDirs(opts.cwd)) {
		const hasClaude = push(join(d, "CLAUDE.md"), PROJECT_DESCRIPTOR);
		// AGENTS.md stands in for a missing CLAUDE.md in this directory.
		if (!hasClaude && opts.agentsFallback) push(join(d, "AGENTS.md"), AGENTS_DESCRIPTOR);
		push(join(d, "CLAUDE.local.md"), LOCAL_DESCRIPTOR);
		if (includeOneCode) {
			const oneCode = firstOneCodeFile(d);
			if (oneCode) push(oneCode, ONECODE_DESCRIPTOR);
		}
	}

	return paths;
}

export function discoverContextFiles(opts: {
	cwd: string;
	homeClaudeDir: string;
	homeOneCodeDir?: string;
	agentsFallback?: boolean;
	/** Home directory for resolving `~` in `@path` imports. */
	home: string;
}): ContextFile[] {
	const files: ContextFile[] = [];
	for (const { path, descriptor } of discoverContextFilePaths(opts)) {
		// Re-check the read: a file present at enumeration but unreadable now is
		// omitted, exactly as before (the block must never carry empty entries).
		const content = readFileIfPresent(path);
		if (content === null) continue;
		files.push({ path, content: expandImports(content, dirname(path), { home: opts.home }), descriptor });
	}
	return files;
}

/**
 * The ONECODE.md files that exist, ordered global-first then farthest ancestor
 * down to cwd (nearer wins). These ride in their own `# oneCodeMd` block, not the
 * `# claudeMd` block, so the latter stays byte-exact with Claude Code.
 */
export function discoverOneCodeFilePaths(opts: { cwd: string; homeOneCodeDir: string }): ContextFilePath[] {
	const paths: ContextFilePath[] = [];
	const seen = new Set<string>();
	const push = (path: string | null, descriptor: string) => {
		if (!path || seen.has(path)) return;
		paths.push({ path, descriptor });
		seen.add(path);
	};
	push(firstOneCodeFile(opts.homeOneCodeDir), ONECODE_GLOBAL_DESCRIPTOR);
	for (const d of ancestorDirs(opts.cwd)) push(firstOneCodeFile(d), ONECODE_DESCRIPTOR);
	return paths;
}

/** ONECODE.md files with `@import`s expanded, for the `# oneCodeMd` block. */
export function discoverOneCodeFiles(opts: { cwd: string; homeOneCodeDir: string; home: string }): ContextFile[] {
	const files: ContextFile[] = [];
	for (const { path, descriptor } of discoverOneCodeFilePaths(opts)) {
		const content = readFileIfPresent(path);
		if (content === null) continue;
		files.push({ path, content: expandImports(content, dirname(path), { home: opts.home }), descriptor });
	}
	return files;
}

const ONECODE_PREAMBLE =
	"# oneCodeMd\n" +
	"The following are One Code-specific instructions, read only by One Code and not by other tools. " +
	"IMPORTANT: they take precedence over the CLAUDE.md instructions above and over any default behavior — " +
	"where they conflict with CLAUDE.md, follow these. Follow them exactly as written.";

/**
 * Assemble the `# oneCodeMd` block's inner text (wrapper added by lib/reminders.ts):
 * the precedence preamble, then one `Contents of {path} ({descriptor}):\n\n{content}`
 * section per file (same raw-content join as the claudeMd block). Returns null when
 * there are no ONECODE.md files, so nothing extra rides when the feature is unused.
 */
export function buildOneCodeBlock(files: ContextFile[]): string | null {
	if (files.length === 0) return null;
	const sections = files.map((s) => `Contents of ${s.path} (${s.descriptor}):\n\n${s.content}`).join("\n");
	return `${ONECODE_PREAMBLE}\n\n${sections}`;
}

export const AGENTS_DESCRIPTOR = "cross-tool agent instructions, AGENTS.md standard";

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
