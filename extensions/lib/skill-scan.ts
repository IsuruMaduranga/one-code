/**
 * Skill discovery for the /plugins Installed tab (pure fs).
 *
 * Scans the same directories the skill/claude-compat extensions feed to pi —
 * project and user `.claude/skills` plus the agent dir — and merges the plugin
 * skills the caller resolved. Rows carry the SKILL.md path (for the ~token
 * size estimate) and the scope used by skill-overrides keys.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PluginSkill } from "./plugins.ts";
import type { SkillScope } from "./skill-overrides.ts";

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
	if (path.startsWith(join(home, ".claude", "skills")) || path.startsWith(join(agentDir, "skills"))) return "user";
	return "project";
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

export function scanSkills(cwd: string, home: string, agentDir: string, pluginSkills: PluginSkill[]): ScannedSkill[] {
	const skills = new Map<string, ScannedSkill>();
	scanDir(join(cwd, ".claude", "skills"), "project", skills);
	scanDir(join(home, ".claude", "skills"), "user", skills);
	scanDir(join(agentDir, "skills"), "user", skills);
	for (const skill of pluginSkills) {
		skills.set(`plugin:${skill.name}`, { name: skill.name, path: skill.path, scope: "plugin" });
	}
	return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Rough token estimate from the SKILL.md byte size (~4 bytes/token). */
export function estimateSkillTokens(path: string): number {
	try {
		return Math.max(1, Math.round(statSync(path).size / 4));
	} catch {
		return 0;
	}
}
