/**
 * One Code's instruction provider: Claude Code's instruction files on top of
 * the base's AGENTS.md (lib/instructions.ts; decisions/bi-fork.md, "Claude
 * Code compatibility is One Code's profile code").
 *
 * Discovery mirrors Claude Code, not pi's own loader: the managed CLAUDE.md
 * and rules, global `~/.claude/CLAUDE.md` and its rules, then per directory
 * from the farthest ancestor down to the cwd `CLAUDE.md`, `.claude/CLAUDE.md`,
 * the base's AGENTS.md where Claude Code's `instructionFiles` rule takes it,
 * `.claude/AGENTS.md`, `.claude/rules` and `CLAUDE.local.md`. The block stays
 * byte-exact with Claude Code. In independent mode (lib/config-mode.ts) it
 * reads no Claude Code location and passes the base's files through.
 *
 * Nested subtree instruction files come later, when a file under them is read
 * (`nestedInstructionFiles`). Rules parsing, recursive discovery and path
 * matching live in lib/claude-rules.ts (the format stays in the base).
 */

import { basename, dirname, join, relative } from "node:path";
import { type InstructionFiles, readInstructionFiles } from "../../extensions/lib/claude-settings.ts";
import { claudeSourcesOn } from "../../extensions/lib/config-mode.ts";
import { claudeManagedDir, claudeUserDir, isClaudeLocation, isPathAtOrUnder, tryRealpath, absoluteFrom } from "../../extensions/lib/paths.ts";
import { discoverRules, readRuleInstructions, type RuleFile, type RuleOptions } from "../../extensions/lib/claude-rules.ts";
import { readExternalIncludesApproval } from "../../extensions/lib/claude-external-includes.ts";
import type { InstructionSource } from "../../extensions/lib/context-text.ts";
import {
	AGENTS_DESCRIPTOR,
	ancestorDirs,
	baseAgentsPaths,
	type ClassifierFile,
	collectImportedPaths,
	type ContextFile,
	type ContextFilePath,
	expandImports,
	firstOneCodeFile,
	GLOBAL_DESCRIPTOR,
	type InstructionProvider,
	type InstructionView,
	isPresentFile,
	LOCAL_DESCRIPTOR,
	MANAGED_DESCRIPTOR,
	type NestedFile,
	ONECODE_DESCRIPTOR,
	ONECODE_GLOBAL_DESCRIPTOR,
	PROJECT_DESCRIPTOR,
	readFileIfPresent,
} from "../../extensions/lib/instructions.ts";

/**
 * Which instruction files load: Claude Code's `instructionFiles` values
 * (findings §57) in Claude-compatible mode, or `agents-md` in independent mode
 * (lib/config-mode.ts), where no CLAUDE.md-family file is read and every
 * directory's `AGENTS.md` loads.
 */
export type InstructionRule = InstructionFiles | "agents-md";

/** The rule One Code runs under: independent mode's own, else Claude Code's `instructionFiles`. */
export function instructionRule(home: string): InstructionRule {
	return claudeSourcesOn() ? readInstructionFiles(home) : "agents-md";
}

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
 * instructions; `agents-md` reads only `AGENTS.md`, with no Claude Code
 * file at all.
 *
 * When `homeOneCodeDir` is given, One Code's own `ONECODE.md` files join the
 * list: the global one from `~/.onecode` right after the global CLAUDE.md, and
 * each directory's last. The `/memory` picker passes it (so ONECODE.md is an
 * editable target); the model-facing `# claudeMd` block does NOT — there
 * ONECODE.md rides its own `# oneCodeMd` block via `discoverOneCodeFiles`
 * instead, so `# claudeMd` stays byte-exact with CC.
 */
interface DiscoveryOptions {
	cwd: string;
	homeClaudeDir: string;
	homeOneCodeDir?: string;
	managedDir?: string;
	rule?: InstructionRule;
	/** User consent for this project's external instruction imports. Never sourced from project files. */
	includeExternal?: boolean;
	/** The base's AGENTS.md files (lib/instructions.ts baseAgentsPaths); read here when absent. */
	baseAgents?: ContextFilePath[];
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
	const includeOneCode = opts.homeOneCodeDir !== undefined;
	const rule = opts.rule ?? "claude-md";
	const claudeFiles = rule !== "agents-md" && rule !== "managed-only";
	const dirs = ancestorDirs(opts.cwd);
	const baseAgents = new Map((opts.baseAgents ?? baseAgentsPaths(opts.cwd)).map((entry) => [dirname(entry.path), entry]));
	// Each path is checked once per call: the per-project test and the walk share it.
	const presence = new Map<string, boolean>();
	const present = (path: string): boolean => {
		let found = presence.get(path);
		if (found === undefined) presence.set(path, (found = isPresentFile(path)));
		return found;
	};
	const projectHasClaude = () => dirs.some((d) => dirHasClaudeMd(d, present));
	const agentsFiles =
		rule === "agents-md" || rule === "claude-md-and-agents-md" || (rule === "claude-md-or-agents-md" && !projectHasClaude());

	/** Adds the path if present. */
	const push = (path: string, descriptor: InstructionSource): void => {
		if (!present(path) || (rule === "agents-md" && isClaudeLocation(path, opts.homeClaudeDir))) return;
		const key = tryRealpath(path) ?? path;
		if (seen.has(key)) return;
		paths.push({ path, descriptor });
		seen.add(key);
	};

	if (rule !== "agents-md") {
		const managed = opts.managedDir ?? claudeManagedDir();
		push(join(managed, "CLAUDE.md"), MANAGED_DESCRIPTOR);
		paths.push(...rules(join(managed, ".claude", "rules"), "Managed", MANAGED_DESCRIPTOR));
	}
	if (claudeFiles) {
		push(join(opts.homeClaudeDir, "CLAUDE.md"), GLOBAL_DESCRIPTOR);
		paths.push(...rules(join(opts.homeClaudeDir, "rules"), "User", GLOBAL_DESCRIPTOR));
	}
	if (includeOneCode && opts.homeOneCodeDir) {
		const globalOneCode = firstOneCodeFile(opts.homeOneCodeDir);
		if (globalOneCode) push(globalOneCode, ONECODE_GLOBAL_DESCRIPTOR);
	}

	for (const d of dirs) {
		if (claudeFiles) {
			push(join(d, "CLAUDE.md"), PROJECT_DESCRIPTOR);
			if (dirname(d) !== d) push(join(d, ".claude", "CLAUDE.md"), PROJECT_DESCRIPTOR);
		}
		if (agentsFiles) {
			const agentsFile = baseAgents.get(d);
			if (agentsFile) push(agentsFile.path, agentsFile.descriptor);
			// `.claude/AGENTS.md` is a Claude Code location; independent mode reads none.
			if (claudeFiles) push(join(d, ".claude", "AGENTS.md"), AGENTS_DESCRIPTOR);
		}
		if (claudeFiles) {
			if (dirname(d) !== d) paths.push(...rules(join(d, ".claude", "rules"), "Project", PROJECT_DESCRIPTOR));
			push(join(d, "CLAUDE.local.md"), LOCAL_DESCRIPTOR);
		}
		if (includeOneCode) {
			const oneCode = firstOneCodeFile(d);
			if (oneCode) push(oneCode, ONECODE_DESCRIPTOR);
		}
	}

	return paths;
}
/**
 * The instruction files Claude Code attaches when the model reads a file below
 * the working directory (its `nested_memory` attachment): for each directory
 * from just below cwd down to the file's own, `CLAUDE.md`, `.claude/CLAUDE.md`
 * and `CLAUDE.local.md`, under the same rule as the startup block (AGENTS.md
 * per `rule`, decided for the whole project as at startup; none of the
 * CLAUDE.md family and no `.claude` directory in independent mode), plus One
 * Code's ONECODE.md. Directories at or above cwd are left out: the startup
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
	rule: InstructionRule;
	home: string;
	homeClaudeDir?: string;
	managedDir?: string;
	includeExternal?: boolean;
}): { path: string; key: string; content: string; imported: string[] }[] {
	const target = absoluteFrom(opts.cwd, opts.filePath);
	if (target === absoluteFrom(opts.cwd, ".")) return [];
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const inProject = (path: string | undefined): path is string => path !== undefined && isPathAtOrUnder(path, realCwd);
	// Named nested files stay confined to the project. An authorized read of a
	// sibling can still match an ancestor's rule, whose base is that ancestor.
	const realParent = tryRealpath(dirname(target));
	let nestedParent = dirname(target);
	if (!isPathAtOrUnder(nestedParent, opts.cwd) && inProject(realParent)) nestedParent = join(opts.cwd, relative(realCwd, realParent));
	const walkNested = isPathAtOrUnder(nestedParent, opts.cwd) && inProject(realParent);
	const realTarget = tryRealpath(target);
	const claudeFiles = opts.rule !== "agents-md" && opts.rule !== "managed-only";
	const dirs: string[] = [];
	for (let dir = nestedParent; walkNested && isPathAtOrUnder(dir, opts.cwd) && !isPathAtOrUnder(opts.cwd, dir); dir = dirname(dir)) {
		dirs.unshift(dir);
		if (dirname(dir) === dir) break;
	}
	// Independent mode reads no Claude Code location, so it never walks into a `.claude` directory.
	const userDir = opts.homeClaudeDir ?? claudeUserDir(opts.home);
	const allowedLocation = (path: string) => opts.rule !== "agents-md" || !isClaudeLocation(path, userDir);
	const walked = dirs.filter(allowedLocation);
	// claude-md-or-agents-md is decided per project, as at startup: AGENTS.md only where no CLAUDE.md is in play.
	const projectHasClaude = () =>
		[...ancestorDirs(opts.cwd), ...walked].some((dir) => dirHasClaudeMd(dir));
	const agents = opts.rule === "agents-md" || opts.rule === "claude-md-and-agents-md" || (opts.rule === "claude-md-or-agents-md" && !projectHasClaude());
	// Approved external chains use the reference parser below; the legacy fallback stays confined.
	const readAllowed = (path: string) => (allowedLocation(path) ? readFileIfPresent(path) : null);
	const readInProject = (path: string) => (inProject(tryRealpath(path)) ? readAllowed(path) : null);
	const seen = new Set<string>(realTarget ? [realTarget] : []);
	const files: { path: string; key: string; content: string; imported: string[] }[] = [];
	const addRules = (rulesDir: string, scope: RuleOptions["scope"], conditional: boolean) => {
		for (const file of discoverRules({ rulesDir, scope, cwd: opts.cwd, home: opts.home, ...(scope !== "User" ? { includeExternal: opts.includeExternal } : {}), ...(conditional ? { filePath: target } : {}) })) {
			if (seen.has(file.key)) continue;
			seen.add(file.key);
			files.push({ ...file, imported: [] });
		}
	};
	if (opts.rule !== "agents-md") addRules(join(opts.managedDir ?? claudeManagedDir(), ".claude", "rules"), "Managed", true);
	if (claudeFiles) addRules(join(opts.homeClaudeDir ?? claudeUserDir(opts.home), "rules"), "User", true);
	for (const dir of walked) {
		const candidates: string[] = [];
		if (claudeFiles) candidates.push(join(dir, "CLAUDE.md"), join(dir, ".claude", "CLAUDE.md"));
		if (agents) {
			candidates.push(join(dir, "AGENTS.md"));
			if (claudeFiles) candidates.push(join(dir, ".claude", "AGENTS.md"));
		}
		if (claudeFiles) candidates.push(join(dir, "CLAUDE.local.md"));
		const oneCode = firstOneCodeFile(dir);
		if (oneCode) candidates.push(oneCode);
		for (const path of candidates) {
			const key = tryRealpath(path);
			if (!inProject(key) || seen.has(key) || !allowedLocation(path)) continue;
			if (basename(dirname(path)) === ".claude" && basename(path) === "CLAUDE.md") {
				for (const file of readRuleInstructions(path, { cwd: opts.cwd, home: opts.home, scope: "Project", includeExternal: opts.includeExternal })) {
					if (seen.has(file.key)) continue;
					seen.add(file.key);
					files.push({ ...file, imported: [] });
				}
				continue;
			}
			const external = path !== oneCode ? approvedExternalInstructions(path, opts) : undefined;
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
			const read = path === oneCode && opts.includeExternal ? readAllowed : readInProject;
			const imported = [...collectImportedPaths(content, dirname(path), { home: opts.home, read })].map((p) => tryRealpath(p) ?? p);
			for (const p of imported) seen.add(p);
			files.push({ path, key, content: expandImports(content, dirname(path), { home: opts.home, read }), imported });
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
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const readAllowedImport = (path: string) => opts.rule !== "agents-md" || !isClaudeLocation(path, opts.homeClaudeDir) ? readFileIfPresent(path) : null;
	const readProjectImport = (path: string) => {
		const key = tryRealpath(path);
		return key && isPathAtOrUnder(key, realCwd) ? readAllowedImport(path) : null;
	};
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
			if (descriptor === AGENTS_DESCRIPTOR && (imported.has(tryRealpath(path) ?? path) || (trimmed !== "" && contents.has(trimmed)))) continue;
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
		const included = [...collectImportedPaths(content, dirname(path), importOptions)];
		for (const p of included) {
			const importedKey = tryRealpath(p) ?? p;
			imported.add(importedKey);
			emitted.add(importedKey);
		}
		files.push({ path, content: expandImports(content, dirname(path), importOptions), descriptor, ...(content.includes("@") ? { imported: included } : {}) });
		emitted.add(key);
	}
	return files;
}

/** Use CC's parsed records for an approved external chain, without changing legacy no-import bytes. */
function approvedExternalInstructions(path: string, opts: { cwd: string; home: string; homeClaudeDir?: string; rule?: InstructionRule; includeExternal?: boolean }): RuleFile[] | undefined {
	if (!opts.includeExternal) return;
	const files = readRuleInstructions(path, { cwd: opts.cwd, home: opts.home, scope: "Project", includeExternal: true,
		allowPath: (path) => opts.rule !== "agents-md" || !isClaudeLocation(path, opts.homeClaudeDir ?? claudeUserDir(opts.home)),
	});
	const cwd = tryRealpath(opts.cwd) ?? opts.cwd;
	return files.some((file) => file.parent && !isPathAtOrUnder(file.key, cwd)) ? files : undefined;
}

/**
 * The startup warning probe: load with external includes enabled, then keep
 * non-user imports/links outside cwd. Missing, empty, binary-extension and
 * over-depth targets never become records, so they cannot cause a question.
 * This scan is UI-only; its contents must never enter the reminder queue.
 */
export function externalInstructionIncludes(opts: DiscoveryOptions & { home: string }): string[] {
	const outside: string[] = [];
	const seen = new Set<string>();
	const cwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const add = (file: RuleFile) => {
		if ((!file.parent && !file.linkedFrom) || isPathAtOrUnder(file.key, cwd) || seen.has(file.key)) return;
		seen.add(file.key);
		outside.push(file.key);
	};
	const entries = discoverInstructionEntries(opts, (rulesDir, scope, descriptor) => {
		if (scope === "User") return [];
		return discoverRules({ rulesDir, scope, cwd: opts.cwd, home: opts.home, includeExternal: true })
			.map((ruleFile) => ({ path: ruleFile.path, descriptor, ruleFile }));
	});
	for (const { path, descriptor, ruleFile } of entries) {
		if (descriptor === GLOBAL_DESCRIPTOR || descriptor === ONECODE_GLOBAL_DESCRIPTOR || descriptor === ONECODE_DESCRIPTOR) continue;
		if (ruleFile) { add(ruleFile); continue; }
		const dotClaude = descriptor === PROJECT_DESCRIPTOR && basename(dirname(path)) === ".claude" && basename(path) === "CLAUDE.md";
		for (const file of readRuleInstructions(path, { cwd: opts.cwd, home: opts.home, scope: descriptor === MANAGED_DESCRIPTOR ? "Managed" : "Project", includeExternal: true,
			allowPath: (path) => opts.rule !== "agents-md" || !isClaudeLocation(path, opts.homeClaudeDir),
			...(dotClaude ? { ownerDir: dirname(dirname(path)) } : {}),
		})) add(file);
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
 * not change as the session touches new paths (auto-mode/instructions.ts).
 */
export function classifierInstructionFiles(opts: { cwd: string; home: string; homeClaudeDir?: string }): ClassifierFile[] {
	const homeClaudeDir = opts.homeClaudeDir ?? claudeUserDir(opts.home);
	const claude = claudeSourcesOn();
	const includeExternal = claude && readExternalIncludesApproval(opts.cwd, opts.home).approved;
	const rules = claude ? conditionalRules(opts.cwd, opts.home, homeClaudeDir, includeExternal) : [];
	const rule = claude ? "claude-md-and-agents-md" : "agents-md";
	return [...rules, ...discoverContextFiles({ cwd: opts.cwd, homeClaudeDir, rule, home: opts.home, includeExternal })];
}

/** One Code's provider: the rule is read when a view opens, and holds until the next one. */
export const claudeCodeInstructions: InstructionProvider = {
	open({ home }): InstructionView {
		const homeClaudeDir = claudeUserDir(home);
		let rule: InstructionRule | undefined;
		const currentRule = () => (rule ??= instructionRule(home));
		return {
			allowPath: (path) => claudeSourcesOn() || !isClaudeLocation(path, homeClaudeDir),
			paths: (base, { cwd, homeOneCodeDir }) => discoverContextFilePaths({ cwd, homeClaudeDir, homeOneCodeDir, rule: currentRule(), baseAgents: base.filter((entry) => entry.descriptor === AGENTS_DESCRIPTOR) }),
			files: (base, { cwd, includeExternal }) => discoverContextFiles({ cwd, homeClaudeDir, rule: currentRule(), home, includeExternal, baseAgents: base }),
			nested: (_base, { filePath, cwd, includeExternal }) => nestedInstructionFiles({ filePath, cwd, rule: currentRule(), home, homeClaudeDir, includeExternal }),
			externalIncludes: (base, { cwd }) => {
				const outside = externalInstructionIncludes({ cwd, homeClaudeDir, rule: currentRule(), home });
				const seen = new Set(outside);
				return [...outside, ...base.filter((path) => !seen.has(path))];
			},
			classifier: (_base, { cwd }) => classifierInstructionFiles({ cwd, home, homeClaudeDir }),
		};
	},
};
