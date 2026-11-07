/**
 * Skill discovery for the pre-first-turn /skills panel and the bare `/<skill>`
 * command registration (pure fs). (The /plugins Installed tab builds its rows
 * from discoverPlugins directly and no longer calls this.)
 *
 * Scans the SAME directories pi loads, in pi's order — `<agentDir>/skills`
 * (pi's own), then the ones claude-compat feeds it: `~/.claude/skills`,
 * `~/.agents/skills`, `<cwd>/.claude/skills`, `<cwd>/.agents/skills`, and the
 * bundled catalog last — and merges the plugin skills the caller resolved.
 * As in pi, a name loads once (the first wins, so the bundled catalog loses a
 * collision) and a file reached twice through a link counts once, so the
 * banner, `/skills` and `/doctor` count the skills pi actually loads. Rows carry the SKILL.md path (for the ~token
 * size estimate) and the scope used by skill-overrides keys. Before the first
 * turn this scan is the only skill list One Code has (pi resolves skills per
 * turn), so a root missing here is a skill with no `/name` command at startup.
 */

import { featureEnabled } from "./profile.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginSkill } from "./plugins.ts";
import type { SkillScope } from "./skill-overrides.ts";
import { openSources, projectConfigDir, type SkillDir, userConfigDir } from "./sources.ts";
import { isPathAtOrUnder, tryRealpath } from "./paths.ts";
import { parseFrontmatterLoosely } from "./frontmatter.ts";

/** The profile's skill catalog, `<package>/profile/skills` (One Code's: Claude Code's self-contained built-in skills). */
export const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "profile", "skills");

export interface ScannedSkill {
	name: string;
	path: string;
	scope: SkillScope;
}

/**
 * The one scope-classification rule for a skill path: user skills live under
 * the user-scope skill folders (`skillSourceDirs`) and `<agentDir>/skills`;
 * everything else is project scope. Both the scanner and the skill extension classify through this, so a
 * skill never shows different scopes in /plugins vs the skill tool.
 */
export function scopeForPath(path: string, home: string, agentDir: string): SkillScope {
	return scopeIn(path, userSkillRoots(home, agentDir));
}

/** The user-scope skill folders: compute them once for a pass over many skills (`scopeIn`). */
export function userSkillRoots(home: string, agentDir: string): string[] {
	// The user-scope folders do not depend on the working directory, so `home` stands in for it.
	return [...skillSourceDirs(home, home).filter((d) => d.scope === "user").map((d) => d.dir), join(agentDir, "skills")];
}

/** `scopeForPath` against roots from `userSkillRoots`. */
export function scopeIn(path: string, userRoots: readonly string[]): SkillScope {
	return userRoots.some((root) => isPathAtOrUnder(path, root)) ? "user" : "project";
}

/**
 * The skill folders One Code adds to pi's own (`<agentDir>/skills`, which pi
 * scans itself), in load order: the cross-tool `.agents` pair, as the source
 * provider reshapes it (lib/sources.ts `skillDirs`; One Code's adds Claude
 * Code's two, each before its `.agents` twin). `~/.agents` is never moved.
 */
export function skillSourceDirs(cwd: string, home: string): SkillDir[] {
	const base: SkillDir[] = [
		{ dir: join(home, ".agents", "skills"), scope: "user" },
		{ dir: join(cwd, ".agents", "skills"), scope: "project" },
	];
	return openSources(home).skillDirs?.(base, { cwd }) ?? base;
}

/** The prompt-template folders: `commands` in the user and project config folders (lib/sources.ts `configDirs`). */
export function commandDirs(cwd: string, home: string): string[] {
	return [join(userConfigDir(home), "commands"), join(projectConfigDir(cwd), "commands")];
}

function scanDir(dir: string, scope: SkillScope, into: Map<string, ScannedSkill>, seenFiles: Set<string>): void {
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
		if (!existsSync(skillFile)) continue;
		let name = entry;
		try {
			const declared = parseFrontmatterLoosely(readFileSync(skillFile, "utf-8")).frontmatter.name;
			if (typeof declared === "string" && declared) name = declared;
		} catch {
			continue;
		}
		const real = tryRealpath(skillFile) ?? skillFile;
		if (into.has(name) || seenFiles.has(real)) continue;
		seenFiles.add(real);
		into.set(name, { name, path: skillFile, scope });
	}
}

export function scanSkills(
	cwd: string,
	home: string,
	agentDir: string,
	pluginSkills: PluginSkill[],
	bundledSkillsDir?: string,
): ScannedSkill[] {
	// No skill tool, no skills: the banner and the subagent guide read this too (lib/profile.ts).
	if (!featureEnabled("skill")) return [];
	const skills = new Map<string, ScannedSkill>();
	const seenFiles = new Set<string>();
	scanDir(join(agentDir, "skills"), "user", skills, seenFiles);
	for (const { dir, scope } of skillSourceDirs(cwd, home)) scanDir(dir, scope, skills, seenFiles);
	if (bundledSkillsDir) scanDir(bundledSkillsDir, scopeForPath(bundledSkillsDir, home, agentDir), skills, seenFiles);
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
