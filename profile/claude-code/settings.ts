/**
 * Claude Code's own settings readers for One Code's source provider: the
 * paths of its three settings files, and its `instructionFiles` rule. The
 * settings.json format and the ladder stay in the base
 * (extensions/lib/claude-settings.ts); the user file's and managed files'
 * paths stay there too, since the safety floor protects them in every
 * product.
 */

import { join } from "node:path";
import { claudeUserSettingsPath, managedSettingsPaths, readSettingsFile } from "../../extensions/lib/claude-settings.ts";

/** Claude Code's user, project and local settings files. */
export function settingsPaths(cwd: string, home: string): { user: string; project: string; local: string } {
	return {
		user: claudeUserSettingsPath(home),
		project: join(cwd, ".claude", "settings.json"),
		local: join(cwd, ".claude", "settings.local.json"),
	};
}

/** Claude Code's `instructionFiles` values (findings §57); the default is `claude-md-or-agents-md`. */
export type InstructionFiles = "claude-md" | "claude-md-or-agents-md" | "claude-md-and-agents-md" | "managed-only";
const INSTRUCTION_FILES: readonly InstructionFiles[] = ["claude-md", "claude-md-or-agents-md", "claude-md-and-agents-md", "managed-only"];
const LEGACY_PROJECT_INSTRUCTIONS: Record<string, InstructionFiles> = {
	none: "managed-only",
	claude: "claude-md",
	"agents-fallback": "claude-md-or-agents-md",
	both: "claude-md-and-agents-md",
};
/** The AGENTS.md plugin's `pluginConfigs` keys: the id is inferred, so the bare name counts too. */
const AGENTS_MD_PLUGIN_KEYS = ["cc-plugin-agents-md@builtin", "cc-plugin-agents-md"];

/**
 * Claude Code's `instructionFiles` (findings §57): the AGENTS.md plugin's option
 * under `pluginConfigs[<id>].options`, from the user and managed settings
 * (Claude Code reads no project file for it), managed winning. The legacy
 * top-level `projectInstructions` applies only while `instructionFiles` is unset,
 * mapped as Claude Code maps it (an unknown string reads as `claude-md`).
 */
export function readInstructionFiles(home: string): InstructionFiles {
	let instructionFiles: InstructionFiles | undefined;
	let legacy: InstructionFiles | undefined;
	for (const path of [claudeUserSettingsPath(home), ...managedSettingsPaths()]) {
		const file = readSettingsFile(path);
		if (!file) continue;
		const configs = file.pluginConfigs as Record<string, { options?: Record<string, unknown> }> | undefined;
		for (const key of AGENTS_MD_PLUGIN_KEYS) {
			const value = configs?.[key]?.options?.instructionFiles;
			if (INSTRUCTION_FILES.includes(value as InstructionFiles)) instructionFiles = value as InstructionFiles;
		}
		if (typeof file.projectInstructions === "string") legacy = LEGACY_PROJECT_INSTRUCTIONS[file.projectInstructions] ?? "claude-md";
	}
	return instructionFiles ?? legacy ?? "claude-md-or-agents-md";
}
