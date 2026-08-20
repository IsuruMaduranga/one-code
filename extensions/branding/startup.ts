/**
 * Compact startup sections for the banner: Context, Skills, Themes.
 *
 * pi's own startup listing has no per-section switch — hiding the noisy
 * [Extensions] block (20 internal module names) means `quietStartup: true`,
 * which hides everything. So when quiet startup is on, the banner shows its
 * own compact versions of the sections that ARE useful. pi's resourceLoader
 * is not exposed to extensions, so these are re-derived the same way our
 * other extensions derive them (claude-compat's skill dirs, pi's git-root
 * context walk); pi-only extras such as the agent dir's skills/ are included
 * for parity (the caller passes the live agent dir, which honours
 * PI_CODING_AGENT_DIR isolation).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { findGitRoot } from "../lib/git.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";

export interface StartupSection {
	label: string;
	items: string[];
}

/**
 * The project context files One Code actually gathers, from cwd up to the git
 * root (or just cwd outside a repo), for the startup banner. Mirrors what the
 * blocks send: a directory's CLAUDE.md, or its AGENTS.md when it has no CLAUDE.md
 * (CLAUDE.md > AGENTS.md), plus CLAUDE.local.md and ONECODE.md when present — so
 * AGENTS.md is listed only when it's really in play, not whenever it exists.
 */
export function contextFileNames(cwd: string): string[] {
	const stop = findGitRoot(cwd) ?? cwd;
	const found: string[] = [];
	let dir = cwd;
	while (true) {
		const rel = (name: string) => relative(cwd, join(dir, name)) || name;
		const present = (name: string) => existsSync(join(dir, name));
		// CLAUDE.md is primary; AGENTS.md stands in only when there is no CLAUDE.md.
		if (present("CLAUDE.md")) found.push(rel("CLAUDE.md"));
		else if (present("AGENTS.md")) found.push(rel("AGENTS.md"));
		if (present("CLAUDE.local.md")) found.push(rel("CLAUDE.local.md"));
		for (const name of ["ONECODE.md", "onecode.md", "OneCode.md"]) {
			if (present(name)) {
				found.push(rel(name));
				break;
			}
		}
		if (dir === stop) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

/**
 * Skills across the same sources our extensions feed to pi: project/user
 * Claude Code dirs, pi's own user dir, and installed plugins. An entry counts
 * when <dir>/<name>/SKILL.md exists — existsSync follows symlinked skill
 * directories, which readdir's isDirectory() would miss.
 */
export function skillNames(cwd: string, home: string, agentDir: string): string[] {
	const dirs = [
		join(cwd, ".claude", "skills"),
		join(home, ".claude", "skills"),
		join(agentDir, "skills"),
	];
	const names = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				if (existsSync(join(dir, entry, "SKILL.md"))) names.add(entry);
			}
		} catch {
			// Unreadable dir: skip, same as pi would.
		}
	}
	for (const skill of discoverPlugins(defaultDiscoverRoots(agentDir, cwd, home)).skills) {
		names.add(skill.name);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/** Saved workflow names from the Claude Code layout dirs (project shadows user). */
export function workflowNames(cwd: string, home: string): string[] {
	const names = new Set<string>();
	for (const dir of [join(cwd, ".claude", "workflows"), join(home, ".claude", "workflows")]) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				if (entry.endsWith(".js") || entry.endsWith(".mjs")) names.add(entry.replace(/\.(js|mjs)$/, ""));
			}
		} catch {
			// Unreadable dir: skip, same as pi would.
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/** Theme names bundled with this package. */
export function themeNames(packageThemesDir: string): string[] {
	try {
		return readdirSync(packageThemesDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => basename(f, ".json"))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/**
 * Whether One Code should default thinking blocks to collapsed (the Claude Code
 * look: a one-line label, expanded on demand). Only when the user has never
 * chosen: a `hideThinkingBlock` key in pi's global settings — written by
 * ctrl+t, /settings, or a previous run of this default — is their decision and
 * is never overridden. An unreadable settings file means "don't touch it".
 */
export function shouldDefaultHideThinking(settingsRaw: string | undefined): boolean {
	if (settingsRaw === undefined) return true;
	try {
		const settings = JSON.parse(settingsRaw);
		return !(settings && typeof settings === "object" && "hideThinkingBlock" in settings);
	} catch {
		return false;
	}
}

/**
 * Whether One Code should default pi's output padding to 0 — flush-left — so the
 * assistant "●" marker (see `assistant-marker.ts`) lines up with the tool "●"
 * bullets, which render at column 0. Same rule as the thinking default: only when
 * the user has never set `outputPad` themselves (via `/settings` or a previous
 * run of this default). An unreadable settings file means "don't touch it".
 */
export function shouldDefaultFlushOutputPad(settingsRaw: string | undefined): boolean {
	if (settingsRaw === undefined) return true;
	try {
		const settings = JSON.parse(settingsRaw);
		return !(settings && typeof settings === "object" && "outputPad" in settings);
	} catch {
		return false;
	}
}

/** True when pi's own startup listing is silenced, so ours should render instead. */
export function quietStartupEnabled(piSettingsPath: string): boolean {
	try {
		const settings = JSON.parse(readFileSync(piSettingsPath, "utf8"));
		return settings?.quietStartup === true;
	} catch {
		return false;
	}
}

export function collectStartupSections(cwd: string, home: string, packageThemesDir: string, agentDir: string): StartupSection[] {
	const sections: StartupSection[] = [
		{ label: "context", items: contextFileNames(cwd) },
		{ label: "skills", items: skillNames(cwd, home, agentDir) },
		{ label: "workflows", items: workflowNames(cwd, home) },
		{ label: "themes", items: themeNames(packageThemesDir) },
	];
	return sections.filter((s) => s.items.length > 0);
}
