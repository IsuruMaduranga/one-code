/**
 * One Code's instruction provider: Claude Code's instruction files on top of
 * the base's AGENTS.md (lib/context/instructions.ts; decisions/bi-fork.md, "Claude
 * Code compatibility is One Code's profile code").
 *
 * Discovery mirrors Claude Code, not pi's own loader: the managed CLAUDE.md
 * and rules, global `~/.claude/CLAUDE.md` and its rules, then per directory
 * from the farthest ancestor down to the cwd `CLAUDE.md`, `.claude/CLAUDE.md`,
 * the base's AGENTS.md where Claude Code's `instructionFiles` rule takes it,
 * `.claude/AGENTS.md`, `.claude/rules` and `CLAUDE.local.md`. The block stays
 * byte-exact with Claude Code. In independent mode (mode.ts) the
 * provider opens no instruction view (sources.ts), so the base's files go
 * through as they are.
 *
 * Nested subtree instruction files come later, when a file under them is read
 * (`nestedInstructionFiles`). Rules parsing, recursive discovery and path
 * matching live in lib/context/claude-rules.ts (the format stays in the base).
 */

import { basename, dirname, join } from "node:path";
import { type InstructionFiles, readInstructionFiles } from "./settings.ts";
import { AGENTS_DESCRIPTOR, AGENTS_GLOBAL_DESCRIPTOR, AGENTS_SOURCES, GLOBAL_DESCRIPTOR, GLOBAL_SOURCES, LOCAL_DESCRIPTOR, MANAGED_DESCRIPTOR, PRODUCT_DESCRIPTOR, PRODUCT_GLOBAL_DESCRIPTOR, PROJECT_DESCRIPTOR, absoluteFrom, ancestorDirs, basePaths, claudeManagedDir, claudeUserDir, discoverRules, expandWithImports, firstProductFile, importReaders, isPathAtOrUnder, isPresentFile, nestedDirs, readExternalIncludesApproval, readFileIfPresent, readRuleInstructions, tryRealpath, uniqueIncludes, type ClassifierFile, type ContextFile, type ContextFilePath, type ExternalInclude, type InstructionSource, type InstructionView, type NestedFile, type RuleFile, type RuleOptions } from "../../extensions/sdk/source-provider.ts";


/**
 * Whether `dir` holds a CLAUDE.md that puts Claude's instructions in play for
 * `claude-md-or-agents-md`: CLAUDE.md, .claude/CLAUDE.md (never at the
 * filesystem root) or CLAUDE.local.md.
 */
function dirHasClaudeMd(dir: string, present: (path: string) => boolean = isPresentFile): boolean {
	return present(join(dir, "CLAUDE.md")) || (dirname(dir) !== dir && present(join(dir, ".claude", "CLAUDE.md"))) || present(join(dir, "CLAUDE.local.md"));
}

/**
 * The ordered instruction-file paths that exist, WITHOUT reading their
 * contents: global `~/.claude/CLAUDE.md` first, then per directory from the
 * farthest ancestor down to cwd `CLAUDE.md`, the AGENTS.md files at its
 * position, and `CLAUDE.local.md`. `discoverContextFiles` reads content on top
 * of this; callers that only need paths/descriptors (e.g. `/memory`'s picker)
 * use it directly to avoid loading files they will discard.
 *
 * `rule` (default `claude-md`) decides the AGENTS.md files, as Claude Code's
 * `instructionFiles` does (findings §57): `claude-md-or-agents-md` loads every
 * ancestor `AGENTS.md` and `.claude/AGENTS.md` only when the project has no
 * `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` anywhere on that path (a per-project
 * decision, so `# claudeMd` stays byte-exact with CC whenever CLAUDE.md is
 * present); `claude-md-and-agents-md` loads them beside CLAUDE.md;
 * `managed-only` drops the user's and the project's files, retaining managed
 * instructions.
 *
 * When `homeProductDir` is given, One Code's own `ONECODE.md` files join the
 * list: the global one from `~/.onecode` right after the global CLAUDE.md, and
 * each directory's last. The `/memory` picker passes it (so ONECODE.md is an
 * editable target); the model-facing `# claudeMd` block does NOT — there
 * ONECODE.md rides its own `# oneCodeMd` block via `discoverProductFiles`
 * instead, so `# claudeMd` stays byte-exact with CC.
 */
interface DiscoveryOptions {
	cwd: string;
	homeClaudeDir: string;
	homeProductDir?: string;
	managedDir?: string;
	rule?: InstructionFiles;
	/** User consent for this project's external instruction imports. Never sourced from project files. */
	includeExternal?: boolean;
	/** The base's files: the global and per-directory AGENTS.md files, and the product files with `homeProductDir` (lib/context/instructions.ts basePaths); found here when absent. */
	base?: readonly ContextFilePath[];
}

export function discoverContextFilePaths(opts: DiscoveryOptions): ContextFilePath[] {
	return discoverInstructionEntries(opts);
}

interface InstructionEntry extends ContextFilePath {
	ruleFile?: RuleFile;
}

function discoverInstructionEntries(
	opts: DiscoveryOptions,
	rules: (dir: string, scope: RuleOptions["scope"], descriptor: InstructionSource) => InstructionEntry[] = () => [],
): InstructionEntry[] {
	const paths: InstructionEntry[] = [];
	const seen = new Set<string>();
	const rule = opts.rule ?? "claude-md";
	const claudeFiles = rule !== "managed-only";
	const dirs = ancestorDirs(opts.cwd);
	const base = opts.base ?? basePaths(opts.cwd, { homeProductDir: opts.homeProductDir });
	// Keyed by the directory as join() spells it, so a cwd given with a trailing separator still matches.
	const inDir = (descriptor: InstructionSource) => new Map(base.filter((entry) => entry.descriptor === descriptor).map((entry) => [dirname(entry.path), entry]));
	const at = (dir: string) => dirname(join(dir, "AGENTS.md"));
	const baseAgents = inDir(AGENTS_DESCRIPTOR);
	// The product files ride in the list only when the caller asked for them (/memory, /doctor, the banner).
	const baseProduct = inDir(PRODUCT_DESCRIPTOR);
	// Each path is checked once per call: the per-project test and the walk share it.
	const presence = new Map<string, boolean>();
	const present = (path: string): boolean => {
		let found = presence.get(path);
		if (found === undefined) presence.set(path, (found = isPresentFile(path)));
		return found;
	};
	const projectHasClaude = () => dirs.some((d) => dirHasClaudeMd(d, present));
	const agentsFiles = rule === "claude-md-and-agents-md" || (rule === "claude-md-or-agents-md" && !projectHasClaude());

	/** Adds the path if present. */
	const push = (path: string, descriptor: InstructionSource): void => {
		if (!present(path)) return;
		const key = tryRealpath(path) ?? path;
		if (seen.has(key)) return;
		paths.push({ path, descriptor });
		seen.add(key);
	};

	const managed = opts.managedDir ?? claudeManagedDir();
	push(join(managed, "CLAUDE.md"), MANAGED_DESCRIPTOR);
	paths.push(...rules(join(managed, ".claude", "rules"), "Managed", MANAGED_DESCRIPTOR));
	if (claudeFiles) {
		push(join(opts.homeClaudeDir, "CLAUDE.md"), GLOBAL_DESCRIPTOR);
		paths.push(...rules(join(opts.homeClaudeDir, "rules"), "User", GLOBAL_DESCRIPTOR));
	}
	// The user's global AGENTS.md files follow the rule as a project's do, with
	// ~/.claude/CLAUDE.md in the role of the project's CLAUDE.md: beside it,
	// only without it, or not at all (decisions/bi-fork.md).
	const globalAgents = rule === "claude-md-and-agents-md" || (rule === "claude-md-or-agents-md" && !present(join(opts.homeClaudeDir, "CLAUDE.md")));
	if (globalAgents) for (const entry of base) if (entry.descriptor === AGENTS_GLOBAL_DESCRIPTOR) push(entry.path, entry.descriptor);
	for (const entry of base) if (entry.descriptor === PRODUCT_GLOBAL_DESCRIPTOR) push(entry.path, entry.descriptor);

	for (const d of dirs) {
		if (claudeFiles) {
			push(join(d, "CLAUDE.md"), PROJECT_DESCRIPTOR);
			if (dirname(d) !== d) push(join(d, ".claude", "CLAUDE.md"), PROJECT_DESCRIPTOR);
		}
		if (agentsFiles) {
			const agentsFile = baseAgents.get(at(d));
			if (agentsFile) push(agentsFile.path, agentsFile.descriptor);
			if (claudeFiles) push(join(d, ".claude", "AGENTS.md"), AGENTS_DESCRIPTOR);
		}
		if (claudeFiles) {
			if (dirname(d) !== d) paths.push(...rules(join(d, ".claude", "rules"), "Project", PROJECT_DESCRIPTOR));
			push(join(d, "CLAUDE.local.md"), LOCAL_DESCRIPTOR);
		}
		const product = baseProduct.get(at(d));
		if (product) push(product.path, product.descriptor);
	}

	return paths;
}
/**
 * The instruction files Claude Code attaches when the model reads a file below
 * the working directory (its `nested_memory` attachment): for each directory
 * from just below cwd down to the file's own, `CLAUDE.md`, `.claude/CLAUDE.md`
 * and `CLAUDE.local.md`, under the same rule as the startup block (AGENTS.md
 * per `rule`, decided for the whole project as at startup), plus One Code's
 * ONECODE.md. Directories at or above cwd are left out: the startup
 * block already carries them. Rules attach in Claude Code's order: managed/user
 * conditional, nested files/rules, then ancestor conditional rules.
 *
 * Named nested files retain One Code's real-path confinement to the project;
 * rules use claude-rules.ts's source-specific link/include policy. A symlink
 * and its target are one file (`key`), and the file being read is never its
 * own attachment. `imported` lists the real paths the legacy inline expander
 * pulled in, so the caller can treat them as shown; parsed imports instead
 * appear as their own files.
 */
export function nestedInstructionFiles(opts: {
	filePath: string;
	cwd: string;
	rule: InstructionFiles;
	home: string;
	homeClaudeDir?: string;
	managedDir?: string;
	includeExternal?: boolean;
}): NestedFile[] {
	const target = absoluteFrom(opts.cwd, opts.filePath);
	if (target === absoluteFrom(opts.cwd, ".")) return [];
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const inProject = (path: string | undefined): path is string => path !== undefined && isPathAtOrUnder(path, realCwd);
	// Named nested files stay confined to the project. An authorized read of a
	// sibling can still match an ancestor's rule, whose base is that ancestor.
	const dirs = nestedDirs(target, opts.cwd);
	const realTarget = tryRealpath(target);
	const claudeFiles = opts.rule !== "managed-only";
	// claude-md-or-agents-md is decided per project, as at startup: AGENTS.md only where no CLAUDE.md is in play.
	const projectHasClaude = () =>
		[...ancestorDirs(opts.cwd), ...dirs].some((dir) => dirHasClaudeMd(dir));
	const agents = opts.rule === "claude-md-and-agents-md" || (opts.rule === "claude-md-or-agents-md" && !projectHasClaude());
	// Approved external chains use the reference parser below; the legacy fallback stays confined.
	const { anywhere: readAllowed, inProject: readInProject } = importReaders(opts.cwd);
	const seen = new Set<string>(realTarget ? [realTarget] : []);
	const files: NestedFile[] = [];
	const addRules = (rulesDir: string, scope: RuleOptions["scope"], conditional: boolean) => {
		for (const file of discoverRules({ rulesDir, scope, cwd: opts.cwd, home: opts.home, ...(scope !== "User" ? { includeExternal: opts.includeExternal } : {}), ...(conditional ? { filePath: target } : {}) })) {
			if (seen.has(file.key)) continue;
			seen.add(file.key);
			files.push({ ...file, imported: [] });
		}
	};
	addRules(join(opts.managedDir ?? claudeManagedDir(), ".claude", "rules"), "Managed", true);
	if (claudeFiles) addRules(join(opts.homeClaudeDir ?? claudeUserDir(opts.home), "rules"), "User", true);
	for (const dir of dirs) {
		const candidates: string[] = [];
		if (claudeFiles) candidates.push(join(dir, "CLAUDE.md"), join(dir, ".claude", "CLAUDE.md"));
		if (agents) {
			candidates.push(join(dir, "AGENTS.md"));
			if (claudeFiles) candidates.push(join(dir, ".claude", "AGENTS.md"));
		}
		if (claudeFiles) candidates.push(join(dir, "CLAUDE.local.md"));
		const product = firstProductFile(dir);
		if (product) candidates.push(product);
		for (const path of candidates) {
			const key = tryRealpath(path);
			if (!inProject(key) || seen.has(key)) continue;
			if (basename(dirname(path)) === ".claude" && basename(path) === "CLAUDE.md") {
				for (const file of readRuleInstructions(path, { cwd: opts.cwd, home: opts.home, scope: "Project", includeExternal: opts.includeExternal })) {
					if (seen.has(file.key)) continue;
					seen.add(file.key);
					files.push({ ...file, imported: [] });
				}
				continue;
			}
			const external = path !== product ? approvedExternalInstructions(path, opts) : undefined;
			if (external) {
				for (const file of external) {
					if (seen.has(file.key)) continue;
					seen.add(file.key);
					files.push({ ...file, imported: [] });
				}
				continue;
			}
			const content = readFileIfPresent(path);
			if (content === null || content.trim() === "") continue;
			seen.add(key);
			// ONECODE.md keeps its inline expander; approval lifts the confinement, as at startup.
			const read = path === product && opts.includeExternal ? readAllowed : readInProject;
			const expanded = expandWithImports(content, dirname(path), { home: opts.home, read });
			const imported = expanded.imported.map((p) => tryRealpath(p) ?? p);
			for (const p of imported) seen.add(p);
			files.push({ path, key, content: expanded.content, imported });
		}
		if (claudeFiles) {
			addRules(join(dir, ".claude", "rules"), "Project", false);
			addRules(join(dir, ".claude", "rules"), "Project", true);
		}
	}
	if (claudeFiles) for (const dir of ancestorDirs(opts.cwd)) if (dirname(dir) !== dir) addRules(join(dir, ".claude", "rules"), "Project", true);
	return files;
}

export function discoverContextFiles(opts: DiscoveryOptions & {
	/** Home directory for resolving `~` in `@path` imports. */
	home: string;
}): ContextFile[] {
	const files: ContextFile[] = [];
	// Under claude-md-and-agents-md an AGENTS.md that a loaded file already
	// imports, or whose content one already carries, is not loaded twice (CC).
	const dedupe = opts.rule === "claude-md-and-agents-md";
	const imported = new Set<string>();
	const contents = new Set<string>();
	const emitted = new Set<string>();
	const parsedShown = new Set<string>();
	const { anywhere: readAllowedImport, inProject: readProjectImport } = importReaders(opts.cwd);
	const appendParsed = (file: RuleFile, descriptor: InstructionSource) => {
		if (emitted.has(file.key)) return;
		emitted.add(file.key);
		parsedShown.add(file.key);
		imported.add(file.key);
		contents.add(file.content.trim());
		files.push({ path: file.path, descriptor, content: file.content.trim(), imported: [] });
	};
	const entries = discoverInstructionEntries(opts, (rulesDir, scope, descriptor) =>
		discoverRules({ rulesDir, scope, cwd: opts.cwd, home: opts.home, ...(scope !== "User" ? { includeExternal: opts.includeExternal } : {}) }).map((ruleFile) => ({ path: ruleFile.path, descriptor, ruleFile })),
	);
	for (const { path, descriptor, ruleFile } of entries) {
		const key = tryRealpath(path) ?? path;
		if (ruleFile) {
			appendParsed(ruleFile, descriptor);
			continue;
		}
		// ~/.claude/CLAUDE.md is the pre-existing global surface, not the new
		// project location: leave its legacy bytes alone when no new files exist.
		const dotClaude = descriptor === PROJECT_DESCRIPTOR && basename(dirname(path)) === ".claude" && basename(path) === "CLAUDE.md";
		if (dotClaude || descriptor === MANAGED_DESCRIPTOR) {
			for (const file of readRuleInstructions(path, { cwd: opts.cwd, home: opts.home, scope: descriptor === MANAGED_DESCRIPTOR ? "Managed" : "Project", includeExternal: opts.includeExternal, ...(dotClaude ? { ownerDir: dirname(dirname(path)) } : {}) })) appendParsed(file, descriptor);
			continue;
		}
		if (parsedShown.has(key)) continue;
		// Re-check the read: a file present at enumeration but unreadable now is
		// omitted, exactly as before (the block must never carry empty entries).
		const content = readFileIfPresent(path);
		if (content === null) continue;
		if (dedupe) {
			const trimmed = content.trim();
			// Compared by real path, so a `./`-spelled or symlinked import still matches.
			if (AGENTS_SOURCES.has(descriptor) && (imported.has(tryRealpath(path) ?? path) || (trimmed !== "" && contents.has(trimmed)))) continue;
			contents.add(trimmed);
		}
		// Keep legacy bytes when no external import exists. Approved external
		// chains use the same parser as the warning probe (escaped spaces,
		// fragments, depth/extension limits and separate imported sections).
		const projectSource = descriptor === PROJECT_DESCRIPTOR || descriptor === LOCAL_DESCRIPTOR || descriptor === AGENTS_DESCRIPTOR;
		const external = projectSource ? approvedExternalInstructions(path, opts) : undefined;
		if (external) {
			for (const file of external) appendParsed(file, descriptor);
			continue;
		}
		const importOptions = { home: opts.home, read: projectSource ? readProjectImport : readAllowedImport };
		const expanded = expandWithImports(content, dirname(path), importOptions);
		for (const p of expanded.imported) {
			const importedKey = tryRealpath(p) ?? p;
			imported.add(importedKey);
			emitted.add(importedKey);
		}
		files.push({ path, content: expanded.content, descriptor, ...(content.includes("@") ? { imported: expanded.imported } : {}) });
		emitted.add(key);
	}
	return files;
}

/** Use CC's parsed records for an approved external chain, without changing legacy no-import bytes. */
function approvedExternalInstructions(path: string, opts: { cwd: string; home: string; includeExternal?: boolean }): RuleFile[] | undefined {
	if (!opts.includeExternal) return;
	const files = readRuleInstructions(path, { cwd: opts.cwd, home: opts.home, scope: "Project", includeExternal: true });
	const cwd = tryRealpath(opts.cwd) ?? opts.cwd;
	return files.some((file) => file.parent && !isPathAtOrUnder(file.key, cwd)) ? files : undefined;
}

/**
 * The startup warning probe: load with external includes enabled, then keep
 * non-user imports/links outside cwd. Missing, empty, binary-extension and
 * over-depth targets never become records, so they cannot cause a question.
 * This scan is UI-only; its contents must never enter the reminder queue.
 */
export function externalInstructionIncludes(opts: DiscoveryOptions & { home: string }): ExternalInclude[] {
	const outside: ExternalInclude[] = [];
	const seen = new Set<string>();
	const cwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const add = (file: RuleFile, importer: string) => {
		if ((!file.parent && !file.linkedFrom) || isPathAtOrUnder(file.key, cwd) || seen.has(file.key)) return;
		seen.add(file.key);
		outside.push({ path: file.key, importer });
	};
	const entries = discoverInstructionEntries(opts, (rulesDir, scope, descriptor) => {
		if (scope === "User") return [];
		return discoverRules({ rulesDir, scope, cwd: opts.cwd, home: opts.home, includeExternal: true })
			.map((ruleFile) => ({ path: ruleFile.path, descriptor, ruleFile }));
	});
	for (const { path, descriptor, ruleFile } of entries) {
		if (GLOBAL_SOURCES.has(descriptor) || descriptor === PRODUCT_DESCRIPTOR) continue;
		// A managed file is not the project's: it is named by its path, so the user looks in the right place.
		const managed = descriptor === MANAGED_DESCRIPTOR;
		if (ruleFile) { add(ruleFile, managed ? dirname(ruleFile.path) : ".claude/rules"); continue; }
		const dotClaude = descriptor === PROJECT_DESCRIPTOR && basename(dirname(path)) === ".claude" && basename(path) === "CLAUDE.md";
		for (const file of readRuleInstructions(path, { cwd: opts.cwd, home: opts.home, scope: managed ? "Managed" : "Project", includeExternal: true,
			...(dotClaude ? { ownerDir: dirname(dirname(path)) } : {}),
		})) add(file, managed ? path : basename(path));
	}
	return outside;
}

/**
 * Every path-conditional rule from the directories the agent reads rules
 * from, under the same consent: managed, the user's, and each ancestor's
 * `.claude/rules`.
 */
function conditionalRules(cwd: string, home: string, homeClaudeDir: string, includeExternal: boolean): RuleFile[] {
	const dirs: { rulesDir: string; scope: "Managed" | "User" | "Project" }[] = [
		{ rulesDir: join(claudeManagedDir(), ".claude", "rules"), scope: "Managed" },
		{ rulesDir: join(homeClaudeDir, "rules"), scope: "User" },
		...ancestorDirs(cwd).filter((dir) => dirname(dir) !== dir).map((dir) => ({ rulesDir: join(dir, ".claude", "rules"), scope: "Project" as const })),
	];
	return dirs.flatMap(({ rulesDir, scope }) =>
		discoverRules({ rulesDir, scope, cwd, home, allConditional: true, ...(scope !== "User" ? { includeExternal } : {}) }),
	);
}

/**
 * The classifier's files: every path-conditional rule, labelled with its
 * globs, then the instruction files with AGENTS.md beside CLAUDE.md
 * whatever `instructionFiles` picks for the agent. An instruction there can
 * only tighten, and the block opens the cached classifier prefix, so it must
 * not change as the session touches new paths (safety/permissions/auto-mode/instructions.ts).
 */
function classifierInstructionFiles(opts: { cwd: string; home: string; homeClaudeDir?: string; base?: readonly ContextFilePath[] }): ClassifierFile[] {
	const homeClaudeDir = opts.homeClaudeDir ?? claudeUserDir(opts.home);
	const includeExternal = readExternalIncludesApproval(opts.cwd, opts.home).approved;
	const rules = conditionalRules(opts.cwd, opts.home, homeClaudeDir, includeExternal);
	return [...rules, ...discoverContextFiles({ cwd: opts.cwd, homeClaudeDir, rule: "claude-md-and-agents-md", home: opts.home, includeExternal, base: opts.base })];
}

/** Claude Code's instruction files for one view (sources.ts): the rule is read on first use, and holds until the next view. */
export function claudeCodeInstructionView(home: string): InstructionView {
	const homeClaudeDir = claudeUserDir(home);
	let rule: InstructionFiles | undefined;
	const currentRule = () => (rule ??= readInstructionFiles(home));
	return {
		paths: (base, { cwd, homeProductDir }) => discoverContextFilePaths({ cwd, homeClaudeDir, homeProductDir, rule: currentRule(), base }),
		// Its own reading replaces the base's (rule files, external chains, deduplication), so the base's contents are never read.
		files: (base, { cwd, includeExternal }) => discoverContextFiles({ cwd, homeClaudeDir, rule: currentRule(), home, includeExternal, base: base.paths }),
		nested: (_base, { filePath, cwd, includeExternal }) => nestedInstructionFiles({ filePath, cwd, rule: currentRule(), home, homeClaudeDir, includeExternal }),
		// Its own scan covers AGENTS.md under the rule; the base's product-file scan is added.
		externalIncludes: (base, { cwd }) => uniqueIncludes([...externalInstructionIncludes({ cwd, homeClaudeDir, rule: currentRule(), home }), ...base.product]),
		classifier: (base, { cwd }) => classifierInstructionFiles({ cwd, home, homeClaudeDir, base: base.paths }),
	};
}
