/**
 * Skill discovery for the pre-first-turn /skills panel and the bare `/<skill>`
 * command registration (pure fs). (The /plugins Installed tab builds its rows
 * from discoverPlugins directly and no longer calls this.)
 *
 * Scans the SAME directories claude-compat feeds to pi, in pi's order —
 * `~/.claude/skills`, `~/.agents/skills`, `<cwd>/.claude/skills`,
 * `<cwd>/.agents/skills`, `<agentDir>/skills`, then the bundled catalog last
 * (so it loses a name collision, as it does in pi) — and merges the plugin
 * skills the caller resolved. Rows carry the SKILL.md path (for the ~token
 * size estimate) and the scope used by skill-overrides keys. Before the first
 * turn this scan is the only skill list One Code has (pi resolves skills per
 * turn), so a root missing here is a skill with no `/name` command at startup.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginSkill } from "./plugins.ts";
import type { SkillScope } from "./skill-overrides.ts";
import { claudeSourcesOn, projectConfigDir, userConfigDir } from "./config-mode.ts";
import { claudeUserDir } from "./paths.ts";

/** The skill catalog shipped in this package: `<package>/skills` (Claude Code's self-contained built-in skills). */
export const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

export interface ScannedSkill {
	name: string;
	path: string;
	scope: SkillScope;
}

/**
 * The one scope-classification rule for a skill path — user skills live under
 * `~/.claude/skills` AND `<agentDir>/skills`; everything else is project
 * scope. Both the scanner and the skill extension classify through this, so a
 * skill never shows different scopes in /plugins vs the skill tool.
 */
export function scopeForPath(path: string, home: string, agentDir: string): SkillScope {
	if (path.startsWith(join(claudeUserDir(home), "skills")) || path.startsWith(join(agentDir, "skills"))) return "user";
	return "project";
}

/**
 * The skill folders One Code adds to pi's own (`<agentDir>/skills`, which pi
 * scans itself), in load order: Claude Code's two only in Claude-compatible
 * mode (lib/config-mode.ts), the cross-tool `.agents` pair in both. `claudeDir`
 * defaults to `~/.claude` (`CLAUDE_CONFIG_DIR`); `~/.agents` is never moved.
 */
export function skillSourceDirs(cwd: string, home: string, claudeDir: string = claudeUserDir(home)): Array<{ dir: string; scope: SkillScope }> {
	const claude = claudeSourcesOn();
	const dirs: Array<{ dir: string; scope: SkillScope } | false> = [
		claude && { dir: join(claudeDir, "skills"), scope: "user" },
		{ dir: join(home, ".agents", "skills"), scope: "user" },
		claude && { dir: join(cwd, ".claude", "skills"), scope: "project" },
		{ dir: join(cwd, ".agents", "skills"), scope: "project" },
	];
	return dirs.filter((d): d is { dir: string; scope: SkillScope } => d !== false);
}

/** The prompt-template folders: `~/.claude/commands` and `.claude/commands`, or their `.onecode` twins in independent mode. */
export function commandDirs(cwd: string, home: string, claudeDir: string = claudeUserDir(home)): string[] {
	return [join(claudeSourcesOn() ? claudeDir : userConfigDir(home), "commands"), join(projectConfigDir(cwd), "commands")];
}

function scanDir(dir: string, scope: SkillScope, into: Map<string, ScannedSkill>): void {
	if (!existsSync(dir)) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const skillFile = join(dir, entry, "SKILL.md");
		// existsSync follows symlinked skill directories, which isDirectory() would miss.
		if (existsSync(skillFile) && !into.has(`${scope}:${entry}`)) {
			into.set(`${scope}:${entry}`, { name: entry, path: skillFile, scope });
		}
	}
}

export function scanSkills(
	cwd: string,
	home: string,
	agentDir: string,
	pluginSkills: PluginSkill[],
	bundledSkillsDir?: string,
): ScannedSkill[] {
	const skills = new Map<string, ScannedSkill>();
	for (const { dir, scope } of skillSourceDirs(cwd, home)) scanDir(dir, scope, skills);
	scanDir(join(agentDir, "skills"), "user", skills);
	if (bundledSkillsDir) scanDir(bundledSkillsDir, scopeForPath(bundledSkillsDir, home, agentDir), skills);
	for (const skill of pluginSkills) {
		skills.set(`plugin:${skill.name}`, { name: skill.name, path: skill.path, scope: "plugin" });
	}
	return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Names of the `.claude/commands` prompt templates (`<name>.md`) pi will expose
 * as `/<name>` — the same dirs claude-compat feeds pi (`~/.claude/commands`,
 * `<cwd>/.claude/commands`, or their `.onecode` twins in independent mode)
 * plus pi's own `<agentDir>/prompts`. pi resolves
 * templates per turn, after `session_start`, so a bare skill command registered
 * then would silently shadow a same-named template for the whole session;
 * this pre-scan lets the registration skip those names.
 */
export function promptTemplateNames(cwd: string, home: string, agentDir: string): string[] {
	return [...new Set(promptTemplateFiles(cwd, home, agentDir).map((file) => file.name))];
}

/** Every prompt-template file pi will resolve, with the command name each gives. */
export function promptTemplateFiles(cwd: string, home: string, agentDir: string): { name: string; path: string }[] {
	const files: { name: string; path: string }[] = [];
	for (const dir of [...commandDirs(cwd, home), join(agentDir, "prompts")]) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) if (entry.endsWith(".md")) files.push({ name: entry.slice(0, -3), path: join(dir, entry) });
	}
	return files;
}

/** Rough token estimate from the SKILL.md byte size (~4 bytes/token). */
export function estimateSkillTokens(path: string): number {
	try {
		return Math.max(1, Math.round(statSync(path).size / 4));
	} catch {
		return 0;
	}
}
