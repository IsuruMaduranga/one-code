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
 * project unless the user approved external imports. A profile's source
 * provider (lib/profile/sources.ts) may reshape the base's lists: its view's
 * `instructions` gets them finished and returns the final ones, and its
 * `allowPath` keeps paths out of every read. One Code's adds Claude Code's
 * CLAUDE.md family (profile/claude-code/instructions.ts); a product without
 * one, or One Code in independent mode, sends the base's lists as they are.
 *
 * Every reader goes through `openInstructions`, so the agent's first message,
 * a read's nested files, the classifier, /memory, /doctor and the startup
 * banner judge the same files. Rendering is context/instructions/instructions.ts.
 *
 * Pure: no pi imports.
 */

import { brand } from "../profile/brand.mjs";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { findGitRoot } from "./git.ts";
import { tryReadFile } from "../plugins/plugins.ts";
import { absoluteFrom, expandTilde, isPathAtOrUnder, productStateDir, tryRealpath } from "../profile/paths.ts";
import { MAX_INSTRUCTION_BYTES } from "./claude-rules.ts";
import { readExternalIncludesApproval } from "./external-includes.ts";
import type { InstructionSource } from "./context-text.ts";
import { activeProfile, featureEnabled } from "../profile/profile.ts";
import { allowedPath, allowPathOf, type InstructionTargets, openSources, projectConfigDirName } from "../profile/sources.ts";

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
export const PRODUCT_DESCRIPTOR: InstructionSource = "product";
export const PRODUCT_GLOBAL_DESCRIPTOR: InstructionSource = "productGlobal";
export const AGENTS_DESCRIPTOR: InstructionSource = "agents";
export const AGENTS_GLOBAL_DESCRIPTOR: InstructionSource = "agentsGlobal";

/** One Code instruction filenames, in preference order (first present per dir wins). */
const PRODUCT_FILE_NAMES = [brand.productFile, brand.productFile.toLowerCase(), `${brand.name}.md`] as const;

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
export function firstProductFile(dir: string): string | null {
	if (!PRODUCT_FILE_NAMES.some((n) => isPresentFile(join(dir, n)))) return null;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}
	const pick = PRODUCT_FILE_NAMES.find((n) => entries.includes(n)) ?? entries.find((e) => e.toLowerCase() === brand.productFile.toLowerCase());
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

/**
 * Readers for an instruction file's imports, both skipping what `allowPath`
 * excludes: `anywhere` for a file the user wrote (a global one), `inProject`
 * for one the project controls, at or under the cwd's real path until the
 * user approves external imports.
 */
export function importReaders(cwd: string, allowPath: (path: string) => boolean = () => true): { anywhere: (path: string) => string | null; inProject: (path: string) => string | null } {
	const realCwd = tryRealpath(cwd) ?? cwd;
	const anywhere = (path: string) => (allowPath(path) ? readFileIfPresent(path) : null);
	const inProject = (path: string) => {
		const key = tryRealpath(path);
		return key && isPathAtOrUnder(key, realCwd) ? anywhere(path) : null;
	};
	return { anywhere, inProject };
}

/** A file's content with its `@` imports inlined, and the paths they resolved to, in one pass (`expandImports`, `collectImportedPaths`). */
export function expandWithImports(content: string, baseDir: string, opts: { home: string; read: (path: string) => string | null }): { content: string; imported: string[] } {
	const imported = new Set<string>();
	const expanded = expandImportsInner(content, baseDir, opts.home, opts.read, new Set<string>(), 0, (path) => imported.add(path));
	return { content: expanded, imported: [...imported] };
}

/**
 * The directories a read of `target` attaches instruction files from: just
 * below `cwd` down to the file's own, inside the project by real path. A
 * parent reached through a link from outside that resolves into the project
 * is walked at its place in the project.
 */
export function nestedDirs(target: string, cwd: string): string[] {
	const realCwd = tryRealpath(cwd) ?? cwd;
	const realParent = tryRealpath(dirname(target));
	const inProject = realParent !== undefined && isPathAtOrUnder(realParent, realCwd);
	let parent = dirname(target);
	if (!isPathAtOrUnder(parent, cwd) && inProject) parent = join(cwd, relative(realCwd, realParent));
	if (!isPathAtOrUnder(parent, cwd) || !inProject) return [];
	const dirs: string[] = [];
	for (let dir = parent; isPathAtOrUnder(dir, cwd) && !isPathAtOrUnder(cwd, dir); dir = dirname(dir)) {
		dirs.unshift(dir);
		if (dirname(dir) === dir) break;
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

/** Which sources are the user's global files, AGENTS.md files, or the product's own. */
export const GLOBAL_SOURCES: ReadonlySet<InstructionSource> = new Set([GLOBAL_DESCRIPTOR, AGENTS_GLOBAL_DESCRIPTOR, PRODUCT_GLOBAL_DESCRIPTOR]);
export const AGENTS_SOURCES: ReadonlySet<InstructionSource> = new Set([AGENTS_DESCRIPTOR, AGENTS_GLOBAL_DESCRIPTOR]);
export const PRODUCT_SOURCES: ReadonlySet<InstructionSource> = new Set([PRODUCT_DESCRIPTOR, PRODUCT_GLOBAL_DESCRIPTOR]);

/** The base's list for a provider: the files that exist, and their contents on demand (a provider that reads them itself never pays for it). */
export interface BaseList<T> {
	paths: ContextFilePath[];
	read(): T[];
}

/**
 * A provider's instruction files for one session's settings
 * (`SourceView.instructions`, lib/profile/sources.ts): each method gets the base's
 * finished list and returns the final one.
 */
export interface InstructionView {
	/** Every instruction file that exists, product files included, in the block's order (/memory, /doctor, the banner). */
	paths(base: ContextFilePath[], opts: { cwd: string; homeOneCodeDir: string }): ContextFilePath[];
	/** The instructions block's files, imports expanded (the product files ride their own block). */
	files(base: BaseList<ContextFile>, opts: { cwd: string; includeExternal: boolean }): ContextFile[];
	/** The files a read of `filePath` attaches, below `cwd` down to the file's directory. */
	nested(base: () => NestedFile[], opts: { filePath: string; cwd: string; includeExternal: boolean }): NestedFile[];
	/** Imports outside `cwd` the user is asked to approve, from the base's two scans; one entry per path. */
	externalIncludes(base: ExternalIncludes, opts: { cwd: string }): ExternalInclude[];
	/** The classifier's files, ahead of the product files: it may see more than the agent, never less. */
	classifier(base: BaseList<ContextFile>, opts: { cwd: string }): ClassifierFile[];
}

const BASE_VIEW: InstructionView = {
	paths: (base) => base,
	files: (base) => base.read(),
	nested: (base) => base(),
	externalIncludes: (base) => uniqueIncludes([...base.agents, ...base.product]),
	classifier: (base) => base.read(),
};

/** The provider's instruction view and read filter for `home`, or the base's own lists unchanged. */
function openView(home: string): { view: InstructionView; allowPath: (path: string) => boolean } {
	const sources = openSources(home);
	return { view: sources.instructions ?? BASE_VIEW, allowPath: allowPathOf(sources) };
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
 * The instruction files the base reads that exist, in one walk: the user's
 * global AGENTS.md files (`globals`), the global product file, then per
 * directory from the farthest ancestor its AGENTS.md and product file. The
 * product files are listed only with `homeOneCodeDir`, the AGENTS.md files
 * unless `agents` is false. Each kind is deduplicated by real path on its
 * own, so a product file linked to an AGENTS.md still rides its own block; a
 * global AGENTS.md that is also a directory's (a home-directory checkout) is
 * listed as that directory's.
 */
export function basePaths(cwd: string, opts: { allowPath?: (path: string) => boolean; globals?: readonly string[]; homeOneCodeDir?: string; agents?: boolean } = {}): ContextFilePath[] {
	const allowPath = opts.allowPath ?? (() => true);
	const agents = opts.agents ?? true;
	const product = opts.homeOneCodeDir;
	const paths: ContextFilePath[] = [];
	const seen = new Set<string>();
	const push = (path: string | null, descriptor: InstructionSource) => {
		if (!path || !isPresentFile(path) || !allowPath(path)) return;
		const key = `${PRODUCT_SOURCES.has(descriptor) ? "product" : "agents"}\0${tryRealpath(path) ?? path}`;
		if (seen.has(key)) return;
		seen.add(key);
		paths.push({ path, descriptor });
	};
	const dirs = ancestorDirs(cwd);
	if (agents) {
		const projectFiles = new Set(dirs.map((dir) => join(dir, "AGENTS.md")).filter(isPresentFile).map((path) => tryRealpath(path) ?? path));
		for (const path of opts.globals ?? []) if (!projectFiles.has(tryRealpath(path) ?? path)) push(path, AGENTS_GLOBAL_DESCRIPTOR);
	}
	if (product !== undefined) push(firstProductFile(product), PRODUCT_GLOBAL_DESCRIPTOR);
	for (const dir of dirs) {
		if (agents) push(join(dir, "AGENTS.md"), AGENTS_DESCRIPTOR);
		if (product !== undefined) push(firstProductFile(dir), PRODUCT_DESCRIPTOR);
	}
	return paths;
}

/** Files read with their imports expanded: a global one's anywhere (the user wrote it), a project one's by `projectRead`. */
function readSources(paths: readonly ContextFilePath[], home: string, readers: ReturnType<typeof importReaders>, projectRead: (path: string) => string | null): ContextFile[] {
	return paths.flatMap(({ path, descriptor }) => {
		const content = readers.anywhere(path);
		if (content === null) return [];
		const read = GLOBAL_SOURCES.has(descriptor) ? readers.anywhere : projectRead;
		const expanded = expandWithImports(content, dirname(path), { home, read });
		return [{ path, descriptor, content: expanded.content, ...(content.includes("@") ? { imported: expanded.imported } : {}) }];
	});
}

/**
 * ONECODE.md files with `@import`s expanded, for the `# oneCodeMd` block. A
 * project file's imports outside the cwd load only with `includeExternal`
 * (the user's consent, as for CLAUDE.md), which `externalIncludes` asks for.
 */
export function discoverOneCodeFiles(opts: { cwd: string; homeOneCodeDir: string; home: string; includeExternal?: boolean; allowPath?: (path: string) => boolean }): ContextFile[] {
	const allowPath = opts.allowPath ?? allowedPath(opts.home);
	return readProductFiles(basePaths(opts.cwd, { allowPath, homeOneCodeDir: opts.homeOneCodeDir, agents: false }), opts.cwd, opts.home, allowPath, opts.includeExternal ?? false);
}

/** The product files among `paths`, read with their imports (outside the project only with `includeExternal`). */
function readProductFiles(paths: readonly ContextFilePath[], cwd: string, home: string, allowPath: (path: string) => boolean, includeExternal: boolean): ContextFile[] {
	const readers = importReaders(cwd, allowPath);
	return readSources(paths.filter((entry) => PRODUCT_SOURCES.has(entry.descriptor)), home, readers, includeExternal ? readers.anywhere : readers.inProject);
}

/**
 * The project's AGENTS.md and ONECODE.md imports outside the cwd, resolved by
 * the expander that would load them, kept apart: a provider decides whether
 * the AGENTS.md files load at all.
 */
function projectExternalIncludes(opts: { cwd: string; home: string; homeOneCodeDir: string; allowPath: (path: string) => boolean }): ExternalIncludes {
	const cwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const { anywhere } = importReaders(opts.cwd, opts.allowPath);
	const found: ExternalIncludes = { agents: [], product: [] };
	for (const { path, descriptor } of basePaths(opts.cwd, opts)) {
		const list = descriptor === PRODUCT_DESCRIPTOR ? found.product : descriptor === AGENTS_DESCRIPTOR ? found.agents : undefined;
		const content = list ? anywhere(path) : null;
		if (!list || content === null) continue;
		for (const imported of expandWithImports(content, dirname(path), { home: opts.home, read: anywhere }).imported) {
			const key = tryRealpath(imported) ?? imported;
			if (!isPathAtOrUnder(key, cwd) && !list.some((found) => found.path === key)) list.push({ path: key, importer: basename(path) });
		}
	}
	return found;
}

/** A file imported from outside the cwd, and the project file whose imports reach it, as the consent dialog names that file. */
export interface ExternalInclude {
	path: string;
	importer: string;
}

/** Imports outside the cwd from the project's AGENTS.md files and from its product files. */
export interface ExternalIncludes {
	agents: ExternalInclude[];
	product: ExternalInclude[];
}

/** One entry per imported path: the first importer found is the one named. */
export function uniqueIncludes(found: readonly ExternalInclude[]): ExternalInclude[] {
	const seen = new Set<string>();
	return found.filter(({ path }) => !seen.has(path) && seen.add(path));
}

/** The base's nested files for a read: each AGENTS.md and product file between `cwd` and the file, inside the project. */
function baseNestedFiles(opts: { filePath: string; cwd: string; home: string; includeExternal: boolean; allowPath: (path: string) => boolean }): NestedFile[] {
	const target = absoluteFrom(opts.cwd, opts.filePath);
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const readers = importReaders(opts.cwd, opts.allowPath);
	const realTarget = tryRealpath(target);
	const seen = new Set<string>(realTarget ? [realTarget] : []);
	const files: NestedFile[] = [];
	for (const dir of nestedDirs(target, opts.cwd)) {
		const oneCode = firstProductFile(dir);
		for (const path of [join(dir, "AGENTS.md"), oneCode]) {
			const key = path ? tryRealpath(path) : undefined;
			if (!path || !key || !isPathAtOrUnder(key, realCwd) || seen.has(key) || !opts.allowPath(path)) continue;
			const content = readFileIfPresent(path);
			if (content === null || content.trim() === "") continue;
			seen.add(key);
			// Imports load from anywhere once approved, as at startup.
			const read = opts.includeExternal ? readers.anywhere : readers.inProject;
			const expanded = expandWithImports(content, dirname(path), { home: opts.home, read });
			const imported = expanded.imported.map((p) => tryRealpath(p) ?? p);
			for (const p of imported) seen.add(p);
			files.push({ path, key, content: expanded.content, imported });
		}
	}
	return files;
}

/** The instruction files for one session's settings: every reader's entry point. */
export interface Instructions {
	/** The agent's sections: the instructions block's files and the product files, imports inlined. */
	sections(opts: { cwd: string; homeOneCodeDir?: string; includeExternal?: boolean }): { contextFiles: ContextFile[]; oneCodeFiles: ContextFile[] };
	/** Every instruction file that exists, product files included, in block order. */
	paths(opts: { cwd: string; homeOneCodeDir?: string }): ContextFilePath[];
	/** The files a read of `filePath` attaches. */
	nested(opts: { filePath: string; cwd: string; includeExternal: boolean }): NestedFile[];
	/** Imports outside `cwd` that need the user's approval, each with the project file that reaches it. */
	externalIncludes(opts: { cwd: string; homeOneCodeDir?: string }): ExternalInclude[];
	/** The classifier's files, the product files last. */
	classifier(opts: { cwd: string; homeOneCodeDir?: string }): ClassifierFile[];
}

/** With the agent's instruction files off, no reader sees any: the classifier, /doctor, /memory and file-tracker judge what the agent gets. */
const NO_INSTRUCTIONS: Instructions = {
	sections: () => ({ contextFiles: [], oneCodeFiles: [] }),
	paths: () => [],
	nested: () => [],
	externalIncludes: () => [],
	classifier: () => [],
};

/**
 * The instruction files under the settings in force now (the active
 * profile's provider, else the base's). `agentDir` is pi's
 * (`getAgentDir()`, passed by the wiring, since this module has no pi
 * import); `undefined` leaves pi's global AGENTS.md out. Nothing while the
 * instructions feature, which carries them to the agent, is off.
 */
export function openInstructions(home: string, agentDir: string | undefined): Instructions {
	if (!featureEnabled("instructions")) return NO_INSTRUCTIONS;
	const { view, allowPath } = openView(home);
	const globals = globalAgentsFiles(home, agentDir);
	const productDir = (dir: string | undefined) => dir ?? productStateDir(process.env, home);
	/** One walk for both blocks: the AGENTS.md list a provider reshapes (contents on demand) and the product files, read with the user's approval. */
	const walk = (cwd: string, homeOneCodeDir: string | undefined, includeExternal: boolean | undefined) => {
		const all = basePaths(cwd, { allowPath, globals, homeOneCodeDir: productDir(homeOneCodeDir) });
		const paths = all.filter((entry) => AGENTS_SOURCES.has(entry.descriptor));
		const readers = importReaders(cwd, allowPath);
		const external = includeExternal ?? readExternalIncludesApproval(cwd, home).approved;
		return {
			// With the user's approval a project AGENTS.md's imports load from anywhere, as the product file's do.
			agents: { paths, read: () => readSources(paths, home, readers, external ? readers.anywhere : readers.inProject) } satisfies BaseList<ContextFile>,
			product: () => readProductFiles(all, cwd, home, allowPath, external),
			external,
		};
	};
	return {
		sections: ({ cwd, homeOneCodeDir, includeExternal }) => {
			const { agents, product, external } = walk(cwd, homeOneCodeDir, includeExternal);
			return { contextFiles: view.files(agents, { cwd, includeExternal: external }), oneCodeFiles: product() };
		},
		paths: ({ cwd, homeOneCodeDir }) => {
			const dir = productDir(homeOneCodeDir);
			return view.paths(basePaths(cwd, { allowPath, globals, homeOneCodeDir: dir }), { cwd, homeOneCodeDir: dir });
		},
		nested: ({ filePath, cwd, includeExternal }) => view.nested(() => baseNestedFiles({ filePath, cwd, home, includeExternal, allowPath }), { filePath, cwd, includeExternal }),
		externalIncludes: ({ cwd, homeOneCodeDir }) => view.externalIncludes(projectExternalIncludes({ cwd, home, homeOneCodeDir: productDir(homeOneCodeDir), allowPath }), { cwd }),
		// The product files with the agent's approval, so the classifier never sees less of them than the agent.
		classifier: ({ cwd, homeOneCodeDir }) => {
			const { agents, product } = walk(cwd, homeOneCodeDir, undefined);
			return [...view.classifier(agents, { cwd }), ...product()];
		},
	};
}

/**
 * The instruction files a user writes (lib/profile/sources.ts `InstructionTargets`):
 * the provider's, else each project's AGENTS.md and the product's global file
 * in its state dir (the one present, else `ONECODE.md`).
 */
export function instructionTargets(home: string = os.homedir(), stateDir: string = productStateDir(process.env, home)): InstructionTargets {
	const provided = openSources(home).instructionTargets;
	if (provided) return provided;
	return { project: "AGENTS.md", user: firstProductFile(stateDir) ?? join(stateDir, brand.productFile) };
}

/** The names of the instruction files a user writes: `CLAUDE.md`, or `AGENTS.md` and the product file's. */
export function instructionFileNames(home: string = os.homedir()): string[] {
	const { project, user } = instructionTargets(home);
	return [...new Set([project, basename(user)])];
}

/**
 * The project's own instruction files in play, from cwd up to the git root
 * (or just cwd outside a repo), nearest directory first, ONECODE.md
 * included. The startup banner lists these; the user's global files are left
 * out, so pi's agent dir is not needed.
 */
export function projectInstructionFiles(opts: { cwd: string; home: string; homeOneCodeDir?: string }): string[] {
	const stop = findGitRoot(opts.cwd) ?? opts.cwd;
	const files = openInstructions(opts.home, undefined).paths({ cwd: opts.cwd, homeOneCodeDir: opts.homeOneCodeDir });
	// The directory a file belongs to: one in a project's config folder (`.claude/AGENTS.md`) counts as its parent's.
	const configDir = projectConfigDirName();
	const owner = (path: string) => (basename(dirname(path)) === configDir ? dirname(dirname(path)) : dirname(path));
	return files
		.filter(({ path, descriptor }) => !GLOBAL_SOURCES.has(descriptor) && isPathAtOrUnder(path, stop))
		.map(({ path }) => path)
		.sort((a, b) => owner(b).length - owner(a).length);
}

/**
 * The agent's instruction sections, as instructions loads them, imports
 * inlined. The one source for every consumer of the window budget
 * (instructions, /doctor, file-tracker, the memory warning, the classifier),
 * so they all judge the same set. `includeExternal` defaults to the project's
 * saved approval; instructions passes the session's own.
 */
export function agentInstructionSections(opts: { cwd: string; home: string; agentDir: string | undefined; homeOneCodeDir?: string; includeExternal?: boolean }): { contextFiles: ContextFile[]; oneCodeFiles: ContextFile[] } {
	return openInstructions(opts.home, opts.agentDir).sections(opts);
}

