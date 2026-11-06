/**
 * One Code's source provider (lib/sources.ts): Claude Code's files on top of
 * the base's locations (decisions/bi-fork.md, "Claude Code compatibility is
 * One Code's profile code", "The provider's shape"). The profile names this
 * module (`sources`), so it loads on first use and is shared once per
 * process: it reads files through lib/ modules that a profile import must not
 * pull in early, and it holds no state.
 *
 * Independent mode (lib/config-mode.ts) switches the provider off: the view
 * then only keeps Claude Code's locations out of every read, and the base's
 * own lists go through as they are.
 */

import { claudeSourcesOn } from "../../extensions/lib/config-mode.ts";
import { join } from "node:path";
import { findProjectConfigs } from "../../extensions/mcp/config.ts";
import { claudeJsonPath, claudeUserDir, isClaudeLocation } from "../../extensions/lib/paths.ts";
import { managedSettingsPaths, settingsPaths } from "../../extensions/lib/claude-settings.ts";
import type { McpFile, SettingsFile, SourceProvider } from "../../extensions/lib/sources.ts";
import { claudeCodeInstructionView } from "./instructions.ts";

export const sources: SourceProvider = {
	open({ home }) {
		const homeClaudeDir = claudeUserDir(home);
		if (!claudeSourcesOn()) return { allowPath: (path) => !isClaudeLocation(path, homeClaudeDir) };
		return {
			instructions: claudeCodeInstructionView(home),
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
			protectedFiles: [claudeJsonPath(home)],
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
		...managedSettingsPaths().map((path): SettingsFile => ({ path, scope: "managed", owner: "borrowed", label: "managed settings" })),
	];
}
