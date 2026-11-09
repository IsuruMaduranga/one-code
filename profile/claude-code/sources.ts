/**
 * One Code's source provider (lib/profile/sources.ts): Claude Code's files on top of
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

import { CONFIG_MODE_ENV, CONFIG_MODE_KEY, claudeSourcesOn, configModeFromEnv, savedConfigMode } from "./mode.ts";
import { existsSync } from "node:fs";
import os from "node:os";
import { claudeJsonPath, claudeUserDir, findProjectConfigs, isClaudeFamilyModel, isClaudeLocation, managedSettingsPaths, productSettingsPath, readSettingsForWrite, tildify, writeSettings, type EnvAlias, type McpFile, type SettingsFile, type SourceProvider, type SourceSwitch } from "../../extensions/sdk/source-provider.ts";
import { join } from "node:path";
import { settingsPaths } from "./settings.ts";
import { claudeCodeInstructionView } from "./instructions.ts";

/**
 * "Config sources": Claude-compatible (the provider on) or independent (off),
 * `configMode` in One Code's user settings or `ONECODE_CONFIG_MODE` for a run
 * (mode.ts).
 */
const configSources: SourceSwitch = {
	title: "Config sources",
	key: CONFIG_MODE_KEY,
	envVar: CONFIG_MODE_ENV,
	on: { label: "Claude-compatible", reads: "~/.claude, CLAUDE.md, .agents and pi's dirs" },
	off: { label: "Independent", reads: "~/.onecode, ONECODE.md, .agents and pi's dirs" },
	running: claudeSourcesOn,
	saved: () => savedConfigMode() === "claude-compatible",
	fromEnv: () => configModeFromEnv() !== undefined,
	save(on) {
		const path = productSettingsPath(os.homedir());
		writeSettings(path, { ...readSettingsForWrite(path), [CONFIG_MODE_KEY]: on ? "claude-compatible" : "independent" });
	},
	describe({ home, env }) {
		if (!claudeSourcesOn()) return "Claude Code config: not read (~/.claude, .claude/, CLAUDE.md, ~/.claude.json, managed settings)";
		const claudeDir = env.CLAUDE_CONFIG_DIR ? `${env.CLAUDE_CONFIG_DIR} (CLAUDE_CONFIG_DIR)` : tildify(claudeUserDir(home, env), home);
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

/** Claude Code's project folder. */
const PROJECT_DIR = ".claude";

/**
 * The knobs Claude Code spells `CLAUDE_CODE_<suffix>`, read after One Code's
 * `ONECODE_<suffix>` (lib/profile/knobs.ts). `CLAUDE_CODE_SUBAGENT_MODEL` applies only
 * on a Claude model: it was written for Claude Code, almost always as an
 * Anthropic alias ("sonnet"), and borrowing it elsewhere moved subagent work
 * off the provider the user chose (observed live: an opencode deepseek
 * session's subagents landing on claude-sonnet-5).
 */
const ENV_ALIASES: Readonly<Record<string, EnvAlias>> = Object.fromEntries(
	[
		"SUBAGENT_MODEL",
		"GIT_BASH_PATH",
		"USE_POWERSHELL_TOOL",
		"DISABLE_AUTO_MEMORY",
		"LOOP_PERSISTENT",
		"LOOP_KEEPALIVE",
		"ENABLE_TODO_TOOLS",
		"TICKLISH_WHISPER_TIMEOUT_MS",
	].map((suffix): [string, EnvAlias] => [
		suffix,
		suffix === "SUBAGENT_MODEL"
			? { name: `CLAUDE_CODE_${suffix}`, appliesTo: isClaudeFamilyModel, limit: "applied only when this session is on a Claude model" }
			: { name: `CLAUDE_CODE_${suffix}` },
	]),
);

export const sources: SourceProvider = {
	switch: configSources,
	open({ home }) {
		const homeClaudeDir = claudeUserDir(home);
		if (!claudeSourcesOn()) return { allowPath: (path) => !isClaudeLocation(path, homeClaudeDir) };
		return {
			instructions: claudeCodeInstructionView(home),
			instructionTargets: { project: "CLAUDE.md", user: join(homeClaudeDir, "CLAUDE.md") },
			configDirs: { user: homeClaudeDir, project: PROJECT_DIR },
			settings: (base, { cwd }) => claudeCodeSettings(base, cwd, home),
			// Each of Claude Code's two skill folders loads before its `.agents` twin.
			skillDirs: (base, { cwd }) => [
				{ dir: join(homeClaudeDir, "skills"), scope: "user" },
				...base.filter((dir) => dir.scope === "user"),
				{ dir: join(cwd, PROJECT_DIR, "skills"), scope: "project" },
				...base.filter((dir) => dir.scope === "project"),
			],
			pluginsDir: join(homeClaudeDir, "plugins"),
			mcpFiles: ({ cwd }) => [
				{ path: claudeJsonPath(home), scope: "user" },
				...findProjectConfigs(cwd).map((path): McpFile => ({ path, scope: "project" })),
				{ path: settingsPaths(cwd, home).local, scope: "local" },
			],
			mcpWhere: ".mcp.json in the project, ~/.claude.json",
			protectedFiles: [{ path: claudeJsonPath(home), label: "Claude Code's .claude.json" }],
			envAliases: ENV_ALIASES,
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
		{ path: paths.project, scope: "project", owner: "borrowed", repo: true, label: "project settings (checked in)" },
		{ path: paths.local, scope: "local", owner: "borrowed", repo: true, label: "project settings (local)" },
		...own("local"),
		...managedSettingsPaths().map((path): SettingsFile => ({ path, scope: "managed", owner: "borrowed", label: "managed settings (organisation policy)" })),
	];
}
