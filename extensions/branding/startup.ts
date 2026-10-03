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
import { basename, join, relative } from "node:path";
import os from "node:os";
import { projectInstructionFiles } from "../lib/claude-context.ts";
import { projectConfigDir, userConfigDir } from "../lib/config-mode.ts";
import { scanSkills } from "../lib/skill-scan.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";
import { oneCodeStateDir } from "../lib/paths.ts";

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
	const { project } = projectInstructionFiles({ cwd, home, homeOneCodeDir: oneCodeStateDir(process.env, home) });
	return project.map((path) => relative(cwd, path) || basename(path));
}

/**
 * Skills across the same sources our extensions feed to pi (lib/skill-scan.ts
 * scanSkills: the mode's skill folders, pi's own user dir, installed plugins),
 * each name once.
 */
export function skillNames(cwd: string, home: string, agentDir: string): string[] {
	const plugins = discoverPlugins(defaultDiscoverRoots(agentDir, cwd, home)).skills;
	return [...new Set(scanSkills(cwd, home, agentDir, plugins).map((skill) => skill.name))].sort((a, b) => a.localeCompare(b));
}

/** Saved workflow names from the mode's workflow dirs (project shadows user). */
export function workflowNames(cwd: string, home: string): string[] {
	const names = new Set<string>();
	for (const dir of [join(projectConfigDir(cwd), "workflows"), join(userConfigDir(home), "workflows")]) {
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
