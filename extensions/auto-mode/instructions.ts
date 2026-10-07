/**
 * Project instruction files for the classifier (pure fs).
 *
 * Claude Code's classifier reads the same CLAUDE.md the agent does, so an
 * instruction like "never force push" steers both at once. This runs the
 * agent's own discovery (lib/claude-context.ts, lib/claude-rules.ts): the
 * managed and global files, every ancestor's CLAUDE.md, `.claude/CLAUDE.md`,
 * `.claude/rules` and CLAUDE.local.md, ONECODE.md, with the same external
 * import consent and symlink confinement, and in independent mode only the
 * AGENTS.md and ONECODE.md files. Two widenings, since an instruction here can
 * only tighten: AGENTS.md loads whatever `instructionFiles` picks for the
 * agent, and every path-conditional rule loads, labelled with its paths, not
 * only those for files the agent has read (the block opens the cached
 * classifier prefix, so it must not change as the session touches new paths).
 *
 * These files are checked in, so they are untrusted input in a way the user's
 * own messages are not — the classifier prompt tells the model they may tighten
 * what is allowed but never widen it. That asymmetry is what makes including
 * them safe; without it, a repository could ship its own authorisation.
 */

import { dirname, join } from "node:path";
import { ancestorDirs, discoverContextFiles, discoverOneCodeFiles } from "../lib/claude-context.ts";
import { readExternalIncludesApproval } from "../lib/claude-external-includes.ts";
import { discoverRules, type RuleFile } from "../lib/claude-rules.ts";
import { claudeSourcesOn } from "../lib/config-mode.ts";
import { claudeManagedDir, claudeUserDir, oneCodeStateDir, tryRealpath } from "../lib/paths.ts";

/** Per-file and total caps, so a large instruction file cannot crowd out rules. */
const PER_FILE_LIMIT = 6_000;
const TOTAL_LIMIT = 12_000;

/** One file the classifier is shown. */
interface InstructionFile {
	path: string;
	content: string;
	/** A path-conditional rule's globs, named in its heading. */
	globs?: string[];
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
 * Concatenated instruction files in the agent's order (managed and global,
 * then each directory from the farthest down, ONECODE.md last), each labelled
 * with its path so the classifier can tell project convention from
 * user-global preference; undefined when there are none. Over the total cap,
 * the nearest files are the ones kept whole.
 */
export function loadProjectInstructions(cwd: string, home: string): string | undefined {
	const claude = claudeSourcesOn();
	const homeClaudeDir = claudeUserDir(home);
	const includeExternal = claude && readExternalIncludesApproval(cwd, home).approved;
	const files: InstructionFile[] = [];
	const seen = new Set<string>();
	const add = (file: InstructionFile) => {
		const key = tryRealpath(file.path) ?? file.path;
		if (seen.has(key) || !file.content.trim()) return;
		seen.add(key);
		files.push(file);
	};
	if (claude) for (const rule of conditionalRules(cwd, home, homeClaudeDir, includeExternal)) add(rule);
	const rule = claude ? "claude-md-and-agents-md" : "agents-md";
	for (const file of discoverContextFiles({ cwd, homeClaudeDir, rule, home, includeExternal })) add(file);
	for (const file of discoverOneCodeFiles({ cwd, homeOneCodeDir: oneCodeStateDir(process.env, home), home })) add(file);

	const chunks = files.map((file) => `# ${file.path}${file.globs ? ` (applies to ${file.globs.join(", ")})` : ""}\n${file.content.trim().slice(0, PER_FILE_LIMIT)}`);
	const kept: string[] = [];
	let budget = TOTAL_LIMIT;
	for (let i = chunks.length - 1; i >= 0 && budget > 0; i--) {
		const chunk = chunks[i].slice(0, budget);
		kept.unshift(chunk);
		budget -= chunk.length;
	}
	return kept.length > 0 ? kept.join("\n\n") : undefined;
}
