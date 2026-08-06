/**
 * The configured default subagent model (pure fs).
 *
 * Two knobs, Claude Code's first:
 *
 * - `CLAUDE_CODE_SUBAGENT_MODEL` — Claude Code's env var. Honored from the real
 *   environment, and from the `env` block of *user and managed* settings files
 *   (Claude Code applies settings `env` to the process; pincer does not, so this
 *   reads the one variable it needs). Project-scope settings are deliberately
 *   not read: both project files live in the repository, and a checked-in `env`
 *   block must not get to pick which provider receives subagent tasks — the
 *   same containment rule as `autoMode` config.
 * - `subagentModel` — pincer's own top-level setting, same shape as
 *   `autoMode.classifierModel`. Wins over the env var when both are set,
 *   because it is the more specific statement of intent.
 *
 * The value is a spec, not a model: "sonnet", "inherit", or "provider/id" all
 * pass through to resolveSubagentModel, which owns the semantics.
 */

import { existsSync, readFileSync } from "node:fs";
import { autoModeSettingsPaths } from "../auto-mode/config.ts";

export interface SubagentDefault {
	spec: string;
	/** Which knob set it, for notices. */
	source: "subagentModel setting" | "CLAUDE_CODE_SUBAGENT_MODEL";
}

interface SettingsFile {
	subagentModel?: unknown;
	env?: Record<string, unknown>;
}

function readSettings(path: string): SettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SettingsFile;
	} catch {
		return undefined;
	}
}

export function loadSubagentDefault(home: string, env: NodeJS.ProcessEnv = process.env): SubagentDefault | undefined {
	let setting: string | undefined;
	let settingsEnv: string | undefined;

	// Lowest precedence first, so managed settings override user settings.
	for (const path of autoModeSettingsPaths(home)) {
		const file = readSettings(path);
		if (!file) continue;
		if (typeof file.subagentModel === "string" && file.subagentModel.trim()) {
			setting = file.subagentModel.trim();
		}
		const fromEnvBlock = file.env?.CLAUDE_CODE_SUBAGENT_MODEL;
		if (typeof fromEnvBlock === "string" && fromEnvBlock.trim()) {
			settingsEnv = fromEnvBlock.trim();
		}
	}

	if (setting) return { spec: setting, source: "subagentModel setting" };

	const fromEnv = env.CLAUDE_CODE_SUBAGENT_MODEL?.trim();
	if (fromEnv) return { spec: fromEnv, source: "CLAUDE_CODE_SUBAGENT_MODEL" };
	if (settingsEnv) return { spec: settingsEnv, source: "CLAUDE_CODE_SUBAGENT_MODEL" };

	return undefined;
}
