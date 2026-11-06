/**
 * One Code's source provider (lib/sources.ts): Claude Code's files on top of
 * the base's locations (decisions/bi-fork.md, "Claude Code compatibility is
 * One Code's profile code", "The provider's shape"). The profile names this
 * module (`sources`), so it loads on first use and is shared once per
 * process: it reads files through lib/ modules that a profile import must not
 * pull in early, and it holds no state.
 *
 * Independent mode (mode.ts) switches the provider off: the view
 * then only keeps Claude Code's locations out of every read, and the base's
 * own lists go through as they are.
 */

import { CONFIG_MODE_KEY, claudeSourcesOn, configModeFromEnv, MODE_LABELS, savedConfigMode } from "./mode.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectConfigs } from "../../extensions/mcp/config.ts";
import { claudeJsonPath, claudeUserDir, isClaudeLocation, tildify } from "../../extensions/lib/paths.ts";
import { managedSettingsPaths, settingsPaths } from "../../extensions/lib/claude-settings.ts";
import type { McpFile, SettingsFile, SourceProvider, SourceSwitch } from "../../extensions/lib/sources.ts";
import { claudeCodeInstructionView } from "./instructions.ts";

/**
 * "Config sources": Claude-compatible (the provider on) or independent (off),
 * `configMode` in One Code's user settings or `ONECODE_CONFIG_MODE` for a run
 * (mode.ts).
 */
const configSources: SourceSwitch = {
	title: "Config sources",
	key: CONFIG_MODE_KEY,
	envVar: "ONECODE_CONFIG_MODE",
	on: { value: "claude-compatible", label: MODE_LABELS["claude-compatible"], reads: "~/.claude, CLAUDE.md, .agents and pi's dirs" },
	off: { value: "independent", label: MODE_LABELS.independent, reads: "~/.onecode, ONECODE.md, .agents and pi's dirs" },
	running: claudeSourcesOn,
	saved: () => savedConfigMode() === "claude-compatible",
	fromEnv: () => configModeFromEnv() !== undefined,
	describe({ home, env }) {
		if (!claudeSourcesOn()) return "Claude Code config: not read (~/.claude, .claude/, CLAUDE.md, ~/.claude.json, managed settings)";
		const claudeDir = env.CLAUDE_CONFIG_DIR ? `${env.CLAUDE_CONFIG_DIR} (CLAUDE_CONFIG_DIR)` : tildify(join(home, ".claude"), home);
		return `Claude Code config read from: ${claudeDir} (never written)`;
	},
	// Independent mode leaves an organisation's policy file unapplied: say so.
	offWarnings: () =>
		claudeSourcesOn()
			? []
			: managedSettingsPaths()
					.filter((path) => existsSync(path))
					.map((path) => ({
						text: `An organisation policy file exists at ${path}, and independent mode does not apply it.`,
						fix: "Switch config sources to Claude-compatible in /memory if this machine's policy must hold.",
					})),
};

export const sources: SourceProvider = {
	switch: configSources,
	open({ home }) {
		const homeClaudeDir = claudeUserDir(home);
		if (!claudeSourcesOn()) return { allowPath: (path) => !isClaudeLocation(path, homeClaudeDir) };
		return {
			instructions: claudeCodeInstructionView(home),
			instructionTargets: { project: "CLAUDE.md", user: join(homeClaudeDir, "CLAUDE.md") },
			configDirs: { user: homeClaudeDir, project: ".claude" },
			settings: (base, { cwd }) => claudeCodeSettings(base, cwd, home),
			// Each of Claude Code's two skill folders loads before its `.agents` twin.
			skillDirs: (base, { cwd }) => [
				{ dir: join(homeClaudeDir, "skills"), scope: "user" },
				...base.filter((dir) => dir.scope === "user"),
				{ dir: join(cwd, ".claude", "skills"), scope: "project" },
				...base.filter((dir) => dir.scope === "project"),
			],
			pluginsDir: join(homeClaudeDir, "plugins"),
			mcpFiles: ({ cwd }) => [
				{ path: claudeJsonPath(home), scope: "user" },
				...findProjectConfigs(cwd).map((path): McpFile => ({ path, scope: "project" })),
				{ path: join(cwd, ".claude", "settings.local.json"), scope: "local" },
			],
			mcpWhere: ".mcp.json in the project, ~/.claude.json",
			protectedFiles: [{ path: claudeJsonPath(home), label: "Claude Code's .claude.json" }],
		};
	},
};

/**
 * Claude Code's ladder around One Code's two files: its user file (the
 * primary one), One Code's user file, the repository's two, One Code's
 * per-project file, then managed policy, which outranks every other file.
 */
function claudeCodeSettings(base: SettingsFile[], cwd: string, home: string): SettingsFile[] {
	const paths = settingsPaths(cwd, home);
	const own = (scope: SettingsFile["scope"]) => base.filter((file) => file.scope === scope);
	return [
		{ path: paths.user, scope: "user", owner: "borrowed", primary: true, label: "Claude Code user settings" },
		...own("user"),
		{ path: paths.project, scope: "project", owner: "borrowed", label: "project settings (checked in)" },
		{ path: paths.local, scope: "local", owner: "borrowed", label: "project settings (local)" },
		...own("local"),
		...managedSettingsPaths().map((path): SettingsFile => ({ path, scope: "managed", owner: "borrowed", label: "managed settings (organisation policy)" })),
	];
}
