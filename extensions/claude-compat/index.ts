/**
 * claude-compat extension — points pi's resource discovery at Claude Code's
 * directory layout:
 *
 *   ~/.claude/skills, <project>/.claude/skills     → skills (same Agent Skills standard)
 *   ~/.agents/skills, <project>/.agents/skills     → skills (the cross-tool Agent Skills
 *                                                    directory, which Claude Code also reads)
 *   ~/.claude/commands, <project>/.claude/commands → slash commands (prompt templates;
 *                                                    Claude Code's $ARGUMENTS works as-is)
 *
 * CLAUDE.md needs no handling — pi discovers it natively alongside AGENTS.md.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claudeConfigDir } from "../lib/paths.ts";

/**
 * `claudeDir` is Claude Code's config dir (honours CLAUDE_CONFIG_DIR), defaulting
 * to `home/.claude`; `home` itself is used only for the unrelated
 * `~/.agents/skills` cross-tool convention, which Claude Code does not relocate
 * via that env var.
 */
export function claudeResourcePaths(
	cwd: string,
	home: string,
	claudeDir: string = join(home, ".claude"),
): { skillPaths: string[]; promptPaths: string[] } {
	const candidates = {
		skillPaths: [
			join(claudeDir, "skills"),
			join(home, ".agents", "skills"),
			join(cwd, ".claude", "skills"),
			join(cwd, ".agents", "skills"),
		],
		promptPaths: [join(claudeDir, "commands"), join(cwd, ".claude", "commands")],
	};
	return {
		skillPaths: candidates.skillPaths.filter((p) => existsSync(p)),
		promptPaths: candidates.promptPaths.filter((p) => existsSync(p)),
	};
}

export default function claudeCompatExtension(pi: ExtensionAPI) {
	pi.on("resources_discover", (event) => {
		return claudeResourcePaths(event.cwd, os.homedir(), claudeConfigDir());
	});
}
