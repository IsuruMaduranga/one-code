/**
 * Instruction files: what the agent, its children and the classifier are told
 * to follow (decisions/bi-fork.md, "Claude Code compatibility is One Code's
 * profile code; the base reads AGENTS.md").
 *
 * The base reads the user's global `AGENTS.md` files (pi's
 * `<agent dir>/AGENTS.md`, then the profile's `globalAgentsFiles`), each
 * directory's `AGENTS.md`, from the farthest ancestor down to the working
 * directory, and the product's own file (`ONECODE.md`, global and per
 * directory), with `@path` imports expanded in place
 * (recursive, depth-capped, cycle-safe, code-span aware) and confined to the
 * project unless the user approved external imports. A profile's provider
 * (`Profile.instructions`) reshapes the base's lists: it gets them finished
 * and returns the final ones. One Code's adds Claude Code's CLAUDE.md family
 * (profile/claude-code/instructions.ts); a product without one sends the
 * base's lists as they are.
 *
 * Every reader goes through `openInstructions`, so the agent's first message,
 * a read's nested files, the classifier, /memory, /doctor and the startup
 * banner judge the same files. Rendering is lib/claude-context.ts.
 *
 * Pure: no pi imports.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { findGitRoot } from "./git.ts";
import { tryReadFile } from "./plugins.ts";
import { absoluteFrom, expandTilde, isPathAtOrUnder, oneCodeStateDir, tryRealpath } from "./paths.ts";
import { MAX_INSTRUCTION_BYTES } from "./claude-rules.ts";
import { readExternalIncludesApproval } from "./claude-external-includes.ts";
import { fitToWindow, type SkippedInstruction } from "./instruction-budget.ts";
import type { InstructionSource } from "./context-text.ts";
import { activeProfile } from "./profile.ts";

/** One instruction section. Legacy content stays raw; new parsed files carry CC's trimmed startup body. */
export interface ContextFile {
	path: string;
	content: string;
	descriptor: InstructionSource;
	/** Actual inline imports; parsed imports are separate sections and use [] to prevent raw @token inference. */
	imported?: string[];
}

// Where each instruction file comes from, as the key its descriptor is worded
// by (the profile's `text.context.section`).
export const GLOBAL_DESCRIPTOR: InstructionSource = "global";
export const MANAGED_DESCRIPTOR: InstructionSource = "managed";
export const PROJECT_DESCRIPTOR: InstructionSource = "project";
export const LOCAL_DESCRIPTOR: InstructionSource = "local";
export const MEMORY_DESCRIPTOR: InstructionSource = "memory";
export const ONECODE_DESCRIPTOR: InstructionSource = "oneCode";
export const ONECODE_GLOBAL_DESCRIPTOR: InstructionSource = "oneCodeGlobal";
export const AGENTS_DESCRIPTOR: InstructionSource = "agents";
export const AGENTS_GLOBAL_DESCRIPTOR: InstructionSource = "agentsGlobal";

/** One Code instruction filenames, in preference order (first present per dir wins). */
const ONECODE_NAMES = ["ONECODE.md", "onecode.md", "One Code.md"] as const;

/** Max `@import` hops, matching Claude Code. Depth 0 is the importing file itself. */
const MAX_IMPORT_DEPTH = 5;

/** A regular file within the instruction size limit (never a FIFO, which would block), else null. */
export function readFileIfPresent(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES) return null;
	} catch {
		return null;
	}
	const content = tryReadFile(path);
	return content === undefined ? null : content;
}

/** A regular file at `path`. */
export function isPresentFile(path: string): boolean {
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
export function firstOneCodeFile(dir: string): string | null {
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
	return absoluteFrom(baseDir, expandTilde(ref, home));
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

/** A discovered instruction file's path and its descriptor, without its content. */
export interface ContextFilePath {
	path: string;
	descriptor: InstructionSource;
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

/** A nested instruction file a read attaches: `imported` lists the real paths its inline imports pulled in. */
export interface NestedFile {
	path: string;
	key: string;
	content: string;
	imported: string[];
}

/** One file the classifier is shown; a path-conditional rule names its globs. */
export interface ClassifierFile {
	path: string;
	content: string;
	globs?: string[];
}

/**
 * A provider's view for one session's settings (`InstructionProvider.open`):
 * each method gets the base's finished list and returns the final one.
 */
export interface InstructionView {
	/** Whether the base may read `path` at all: an AGENTS.md, a product file or an import. */
	allowPath(path: string): boolean;
	/** The instruction files that exist, in the instructions block's order; with `homeOneCodeDir`, the product files too (/memory's picker). */
	paths(base: ContextFilePath[], opts: { cwd: string; homeOneCodeDir?: string }): ContextFilePath[];
	/** The instructions block's files, imports expanded (the product files ride their own block). */
	files(base: ContextFile[], opts: { cwd: string; includeExternal: boolean }): ContextFile[];
	/** The files a read of `filePath` attaches, below `cwd` down to the file's directory. */
	nested(base: NestedFile[], opts: { filePath: string; cwd: string; includeExternal: boolean }): NestedFile[];
	/** Imports outside `cwd` the user is asked to approve. */
	externalIncludes(base: string[], opts: { cwd: string }): string[];
	/** The classifier's files, ahead of the product files: it may see more than the agent, never less. */
	classifier(base: ContextFile[], opts: { cwd: string }): ClassifierFile[];
}

/** A profile's instruction source (`Profile.instructions`). */
export interface InstructionProvider {
	/** A view for the settings in force now; a session keeps one from its startup block to its next refresh. */
	open(opts: { home: string }): InstructionView;
}

const BASE_VIEW: InstructionView = {
	allowPath: () => true,
	paths: (base) => base,
	files: (base) => base,
	nested: (base) => base,
	externalIncludes: (base) => base,
	classifier: (base) => base,
};

/** The active profile's view, or the base's own lists unchanged. */
function openView(home: string): InstructionView {
	return activeProfile().instructions?.open({ home }) ?? BASE_VIEW;
}

/**
 * The user's global AGENTS.md files in reading order: pi's
 * `<agent dir>/AGENTS.md` (pi's `getAgentDir()`, which the wiring passes),
 * then the profile's `globalAgentsFiles`.
 */
function globalAgentsFiles(home: string, agentDir: string | undefined): string[] {
	return [...(agentDir ? [join(agentDir, "AGENTS.md")] : []), ...activeProfile().globalAgentsFiles.map((path) => expandTilde(path, home))];
}

/**
 * The AGENTS.md files that exist, as the base reads them: the user's global
 * ones first (`globalAgentsFiles`), then each directory's, farthest ancestor
 * first.
 */
export function baseAgentsPaths(cwd: string, allowPath: (path: string) => boolean = () => true, globals: readonly string[] = []): ContextFilePath[] {
	const paths: ContextFilePath[] = [];
	const seen = new Set<string>();
	const push = (path: string, descriptor: InstructionSource) => {
		if (!isPresentFile(path) || !allowPath(path)) return;
		const key = tryRealpath(path) ?? path;
		if (seen.has(key)) return;
		seen.add(key);
		paths.push({ path, descriptor });
	};
	for (const path of globals) push(path, AGENTS_GLOBAL_DESCRIPTOR);
	for (const dir of ancestorDirs(cwd)) push(join(dir, "AGENTS.md"), AGENTS_DESCRIPTOR);
	return paths;
}

/**
 * The base's AGENTS.md files with their imports expanded: a project file's
 * confined to the project, a global one's anywhere (the user wrote it, as
 * with the global ONECODE.md).
 */
function baseAgentsFiles(cwd: string, home: string, allowPath: (path: string) => boolean, globals: readonly string[]): ContextFile[] {
	const realCwd = tryRealpath(cwd) ?? cwd;
	const anywhere = (path: string) => (allowPath(path) ? readFileIfPresent(path) : null);
	const inProject = (path: string) => {
		const key = tryRealpath(path);
		return key && isPathAtOrUnder(key, realCwd) ? anywhere(path) : null;
	};
	return baseAgentsPaths(cwd, allowPath, globals).flatMap(({ path, descriptor }) => {
		const content = readFileIfPresent(path);
		if (content === null) return [];
		const importOptions = { home, read: descriptor === AGENTS_GLOBAL_DESCRIPTOR ? anywhere : inProject };
		const imported = [...collectImportedPaths(content, dirname(path), importOptions)];
		return [{ path, descriptor, content: expandImports(content, dirname(path), importOptions), ...(content.includes("@") ? { imported } : {}) }];
	});
}

/** The base's nested files for a read: each AGENTS.md and product file below `cwd` down to the file's directory, inside the project. */
function baseNestedFiles(opts: { filePath: string; cwd: string; home: string; allowPath: (path: string) => boolean }): NestedFile[] {
	const target = absoluteFrom(opts.cwd, opts.filePath);
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const inProject = (path: string | undefined): path is string => path !== undefined && isPathAtOrUnder(path, realCwd);
	const realTarget = tryRealpath(target);
	if (!isPathAtOrUnder(dirname(target), opts.cwd) || !inProject(tryRealpath(dirname(target)))) return [];
	const dirs: string[] = [];
	for (let dir = dirname(target); isPathAtOrUnder(dir, opts.cwd) && !isPathAtOrUnder(opts.cwd, dir); dir = dirname(dir)) dirs.unshift(dir);
	const read = (path: string) => (inProject(tryRealpath(path)) && opts.allowPath(path) ? readFileIfPresent(path) : null);
	const seen = new Set<string>(realTarget ? [realTarget] : []);
	const files: NestedFile[] = [];
	for (const dir of dirs) {
		for (const path of [join(dir, "AGENTS.md"), firstOneCodeFile(dir)]) {
			if (!path) continue;
			const key = tryRealpath(path);
			if (!inProject(key) || seen.has(key) || !opts.allowPath(path)) continue;
			const content = readFileIfPresent(path);
			if (content === null || content.trim() === "") continue;
			seen.add(key);
			const imported = [...collectImportedPaths(content, dirname(path), { home: opts.home, read })].map((p) => tryRealpath(p) ?? p);
			for (const p of imported) seen.add(p);
			files.push({ path, key, content: expandImports(content, dirname(path), { home: opts.home, read }), imported });
		}
	}
	return files;
}

/**
 * The ONECODE.md files that exist, ordered global-first then farthest ancestor
 * down to cwd (nearer wins). These ride in their own `# oneCodeMd` block, not the
 * `# claudeMd` block, so the latter stays byte-exact with Claude Code.
 */
function discoverOneCodeFilePaths(opts: { cwd: string; homeOneCodeDir: string }): ContextFilePath[] {
	const paths: ContextFilePath[] = [];
	const seen = new Set<string>();
	const push = (path: string | null, descriptor: InstructionSource) => {
		if (!path) return;
		const key = tryRealpath(path) ?? path;
		if (seen.has(key)) return;
		paths.push({ path, descriptor });
		seen.add(key);
	};
	push(firstOneCodeFile(opts.homeOneCodeDir), ONECODE_GLOBAL_DESCRIPTOR);
	for (const d of ancestorDirs(opts.cwd)) push(firstOneCodeFile(d), ONECODE_DESCRIPTOR);
	return paths;
}

/**
 * The ONECODE.md files present, each with the readers for its `@import`s:
 * `confined` is what loads without consent (anywhere for the user's global
 * file, which the user wrote; at or under the cwd's real path for a project
 * file, like CLAUDE.md), `unconfined` what loads once the user approved.
 * `allowPath` is the provider's (a location the mode excludes is never read).
 */
function oneCodeSources(opts: { cwd: string; homeOneCodeDir: string; home: string; allowPath: (path: string) => boolean }): {
	path: string;
	descriptor: InstructionSource;
	content: string;
	confined: (path: string) => string | null;
	unconfined: (path: string) => string | null;
}[] {
	const unconfined = (path: string) => opts.allowPath(path) ? readFileIfPresent(path) : null;
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const inProject = (path: string) => {
		const key = tryRealpath(path);
		return key && isPathAtOrUnder(key, realCwd) ? unconfined(path) : null;
	};
	return discoverOneCodeFilePaths(opts).flatMap(({ path, descriptor }) => {
		const content = unconfined(path);
		return content === null ? [] : [{ path, descriptor, content, unconfined, confined: descriptor === ONECODE_DESCRIPTOR ? inProject : unconfined }];
	});
}

/**
 * ONECODE.md files with `@import`s expanded, for the `# oneCodeMd` block. A
 * project file's imports outside the cwd load only with `includeExternal`
 * (the user's consent, as for CLAUDE.md), which `externalIncludes` asks for.
 */
export function discoverOneCodeFiles(opts: { cwd: string; homeOneCodeDir: string; home: string; includeExternal?: boolean; allowPath?: (path: string) => boolean }): ContextFile[] {
	const allowPath = opts.allowPath ?? openView(opts.home).allowPath;
	return oneCodeSources({ ...opts, allowPath }).map(({ path, descriptor, content, confined, unconfined }) => {
		const importOptions = { home: opts.home, read: opts.includeExternal ? unconfined : confined };
		const imported = [...collectImportedPaths(content, dirname(path), importOptions)];
		return { path, content: expandImports(content, dirname(path), importOptions), descriptor, ...(content.includes("@") ? { imported } : {}) };
	});
}

/** A project ONECODE.md's imports outside the cwd, resolved by the expander that would load them. */
function oneCodeExternalIncludes(opts: { cwd: string; home: string; homeOneCodeDir: string; allowPath: (path: string) => boolean }): string[] {
	const cwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const outside: string[] = [];
	const seen = new Set<string>();
	for (const source of oneCodeSources(opts)) {
		if (source.descriptor !== ONECODE_DESCRIPTOR) continue;
		for (const imported of collectImportedPaths(source.content, dirname(source.path), { home: opts.home, read: source.unconfined })) {
			const key = tryRealpath(imported) ?? imported;
			if (isPathAtOrUnder(key, cwd) || seen.has(key)) continue;
			seen.add(key);
			outside.push(key);
		}
	}
	return outside;
}

/** The base's paths for the picker: the global AGENTS.md and product files, then per directory its AGENTS.md and product file. */
function basePaths(cwd: string, homeOneCodeDir: string | undefined, allowPath: (path: string) => boolean, globals: readonly string[]): ContextFilePath[] {
	const all = baseAgentsPaths(cwd, allowPath, globals);
	if (homeOneCodeDir === undefined) return all;
	const agents = new Map(all.filter((entry) => entry.descriptor === AGENTS_DESCRIPTOR).map((entry) => [dirname(entry.path), entry]));
	const paths: ContextFilePath[] = all.filter((entry) => entry.descriptor === AGENTS_GLOBAL_DESCRIPTOR);
	const globalOneCode = firstOneCodeFile(homeOneCodeDir);
	if (globalOneCode && allowPath(globalOneCode)) paths.push({ path: globalOneCode, descriptor: ONECODE_GLOBAL_DESCRIPTOR });
	for (const dir of ancestorDirs(cwd)) {
		const agentsFile = agents.get(dir);
		if (agentsFile) paths.push(agentsFile);
		const oneCode = firstOneCodeFile(dir);
		if (oneCode && allowPath(oneCode)) paths.push({ path: oneCode, descriptor: ONECODE_DESCRIPTOR });
	}
	return paths;
}

/** The instruction files for one session's settings: every reader's entry point. */
export interface Instructions {
	/** Whether a path may be read as an instruction (a location the mode excludes may not). */
	allowPath(path: string): boolean;
	/** The agent's sections: the instructions block's files and the product files, imports inlined. */
	sections(opts: { cwd: string; homeOneCodeDir?: string; includeExternal?: boolean }): { contextFiles: ContextFile[]; oneCodeFiles: ContextFile[] };
	/** The files that exist, in block order, with the product files when `homeOneCodeDir` is given. */
	paths(opts: { cwd: string; homeOneCodeDir?: string }): ContextFilePath[];
	/** The files a read of `filePath` attaches. */
	nested(opts: { filePath: string; cwd: string; includeExternal: boolean }): NestedFile[];
	/** Imports outside `cwd` that need the user's approval. */
	externalIncludes(opts: { cwd: string; homeOneCodeDir?: string }): string[];
	/** The classifier's files, the product files last. */
	classifier(opts: { cwd: string; homeOneCodeDir?: string }): ClassifierFile[];
}

/**
 * The instruction files under the settings in force now (the active
 * profile's provider, else the base's). `agentDir` is pi's
 * (`getAgentDir()`, passed by the wiring, since this module has no pi
 * import): without it pi's global AGENTS.md is not read.
 */
export function openInstructions(home: string, agentDir?: string): Instructions {
	const view = openView(home);
	const allowPath = (path: string) => view.allowPath(path);
	const globals = globalAgentsFiles(home, agentDir);
	const productDir = (dir: string | undefined) => dir ?? oneCodeStateDir(process.env, home);
	return {
		allowPath,
		sections: ({ cwd, homeOneCodeDir, includeExternal }) => {
			const external = includeExternal ?? readExternalIncludesApproval(cwd, home).approved;
			return {
				contextFiles: view.files(baseAgentsFiles(cwd, home, allowPath, globals), { cwd, includeExternal: external }),
				oneCodeFiles: discoverOneCodeFiles({ cwd, homeOneCodeDir: productDir(homeOneCodeDir), home, includeExternal: external, allowPath }),
			};
		},
		paths: ({ cwd, homeOneCodeDir }) => view.paths(basePaths(cwd, homeOneCodeDir, allowPath, globals), { cwd, homeOneCodeDir }),
		nested: ({ filePath, cwd, includeExternal }) => view.nested(baseNestedFiles({ filePath, cwd, home, allowPath }), { filePath, cwd, includeExternal }),
		externalIncludes: ({ cwd, homeOneCodeDir }) => view.externalIncludes(oneCodeExternalIncludes({ cwd, home, homeOneCodeDir: productDir(homeOneCodeDir), allowPath }), { cwd }),
		classifier: ({ cwd, homeOneCodeDir }) => [
			...view.classifier(baseAgentsFiles(cwd, home, allowPath, globals), { cwd }),
			...discoverOneCodeFiles({ cwd, homeOneCodeDir: productDir(homeOneCodeDir), home, allowPath }),
		],
	};
}

/**
 * The project's own instruction files in play, from cwd up to the git root
 * (or just cwd outside a repo), nearest directory first; with
 * `homeOneCodeDir`, its ONECODE.md files too. The startup banner lists these.
 */
export function projectInstructionFiles(opts: { cwd: string; home: string; homeOneCodeDir?: string }): string[] {
	const global = new Set([GLOBAL_DESCRIPTOR, ONECODE_GLOBAL_DESCRIPTOR, AGENTS_GLOBAL_DESCRIPTOR]);
	const stop = findGitRoot(opts.cwd) ?? opts.cwd;
	const files = openInstructions(opts.home).paths({ cwd: opts.cwd, homeOneCodeDir: opts.homeOneCodeDir });
	// The directory a file belongs to: `.claude/AGENTS.md` counts as its parent's.
	const owner = (path: string) => (basename(dirname(path)) === ".claude" ? dirname(dirname(path)) : dirname(path));
	return files
		.filter(({ path, descriptor }) => !global.has(descriptor) && isPathAtOrUnder(path, stop))
		.map(({ path }) => path)
		.sort((a, b) => owner(b).length - owner(a).length);
}

/**
 * The agent's instruction sections, as claude-context loads them, imports
 * inlined. The one source for every consumer of the window budget
 * (claude-context, /doctor, file-tracker, the memory warning, the classifier),
 * so they all judge the same set. `includeExternal` defaults to the project's
 * saved approval; claude-context passes the session's own.
 */
export function agentInstructionSections(opts: { cwd: string; home: string; agentDir: string | undefined; homeOneCodeDir?: string; includeExternal?: boolean }): { contextFiles: ContextFile[]; oneCodeFiles: ContextFile[] } {
	return openInstructions(opts.home, opts.agentDir).sections(opts);
}

/** The sections the agent's window budget skips for `contextWindow` (lib/instruction-budget.ts); none without a window. */
export function agentSkippedInstructions(opts: Parameters<typeof agentInstructionSections>[0] & { contextWindow: number | undefined }): SkippedInstruction[] {
	if (!opts.contextWindow) return [];
	const { contextFiles, oneCodeFiles } = agentInstructionSections(opts);
	return fitToWindow([...contextFiles, ...oneCodeFiles], opts.contextWindow).skipped;
}
