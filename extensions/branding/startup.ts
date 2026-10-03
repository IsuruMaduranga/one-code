/**
 * Compact startup sections for the banner: Context, Skills, Themes.
 *
 * pi's own startup listing has no per-section switch — hiding the noisy
 * [Extensions] block (20 internal module names) means `quietStartup`, which
 * hides the whole listing. So when quiet startup is on, the banner shows its
 * own compact versions of the sections that ARE useful. pi's resourceLoader
 * is not exposed to extensions, so these are re-derived the same way our
 * other extensions derive them (claude-compat's skill dirs, pi's git-root
 * context walk); pi-only extras such as the agent dir's skills/ are included
 * for parity (the caller passes the live agent dir, which honours
 * PI_CODING_AGENT_DIR isolation).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import os from "node:os";
import { discoverContextFilePaths, GLOBAL_DESCRIPTOR, instructionRule, ONECODE_GLOBAL_DESCRIPTOR } from "../lib/claude-context.ts";
import { findGitRoot } from "../lib/git.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";
import { claudeUserDir, isPathAtOrUnder, oneCodeStateDir } from "../lib/paths.ts";

export interface StartupSection {
	label: string;
	items: string[];
}

/**
 * The project context files One Code actually gathers, from cwd up to the git
 * root (or just cwd outside a repo), nearest directory first, for the startup
 * banner. The same discovery and rule the blocks use (lib/claude-context.ts),
 * so an AGENTS.md is listed only when it is really in play.
 */
export function contextFileNames(cwd: string, home: string = os.homedir()): string[] {
	const stop = findGitRoot(cwd) ?? cwd;
	const files = discoverContextFilePaths({
		cwd,
		homeClaudeDir: claudeUserDir(home),
		homeOneCodeDir: oneCodeStateDir(process.env, home),
		rule: instructionRule(home),
	}).filter(({ path, descriptor }) => descriptor !== GLOBAL_DESCRIPTOR && descriptor !== ONECODE_GLOBAL_DESCRIPTOR && isPathAtOrUnder(path, stop));
	// The directory a file belongs to: `.claude/AGENTS.md` counts as its parent's.
	const owner = (path: string) => (basename(dirname(path)) === ".claude" ? dirname(dirname(path)) : dirname(path));
	return files
		.map(({ path }) => path)
		.sort((a, b) => owner(b).length - owner(a).length)
		.map((path) => relative(cwd, path) || basename(path));
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
		join(claudeUserDir(home), "skills"),
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
	for (const dir of [join(cwd, ".claude", "workflows"), join(claudeUserDir(home), "workflows")]) {
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

/**
 * True when pi's own startup listing is silenced, so ours should render instead:
 * `quietStartup: true`, or pi 1.0's `"header"`, which keeps pi's header and
 * still hides the listing.
 */
export function quietStartupEnabled(piSettingsPath: string): boolean {
	try {
		const settings = JSON.parse(readFileSync(piSettingsPath, "utf8"));
		return settings?.quietStartup === true || settings?.quietStartup === "header";
	} catch {
		return false;
	}
}

export function collectStartupSections(cwd: string, home: string, packageThemesDir: string, agentDir: string): StartupSection[] {
	const sections: StartupSection[] = [
		{ label: "context", items: contextFileNames(cwd, home) },
		{ label: "skills", items: skillNames(cwd, home, agentDir) },
		{ label: "workflows", items: workflowNames(cwd, home) },
		{ label: "themes", items: themeNames(packageThemesDir) },
	];
	return sections.filter((s) => s.items.length > 0);
}
