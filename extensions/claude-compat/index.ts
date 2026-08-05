/**
 * claude-compat extension — points pi's resource discovery at Claude Code's
 * directory layout:
 *
 *   ~/.claude/skills, <project>/.claude/skills     → skills (same Agent Skills standard)
 *   ~/.claude/commands, <project>/.claude/commands → slash commands (prompt templates;
 *                                                    Claude Code's $ARGUMENTS works as-is)
 *
 * CLAUDE.md needs no handling — pi discovers it natively alongside AGENTS.md.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function claudeResourcePaths(cwd: string, home: string): { skillPaths: string[]; promptPaths: string[] } {
	const candidates = {
		skillPaths: [join(home, ".claude", "skills"), join(cwd, ".claude", "skills")],
		promptPaths: [join(home, ".claude", "commands"), join(cwd, ".claude", "commands")],
	};
	return {
		skillPaths: candidates.skillPaths.filter((p) => existsSync(p)),
		promptPaths: candidates.promptPaths.filter((p) => existsSync(p)),
	};
}

export default function claudeCompatExtension(pi: ExtensionAPI) {
	pi.on("resources_discover", (event) => {
		return claudeResourcePaths(event.cwd, os.homedir());
	});
}
