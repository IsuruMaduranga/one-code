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
 * It also points discovery at the catalog of skills bundled with this package
 * (`<package>/skills`) — Claude Code's self-contained built-in skills, which
 * ship inside its binary rather than on disk, so nothing else would surface
 * them. See working-docs/decisions/skills-plugins.md and working-docs/findings (the extraction
 * process is recorded in .claude/skills/extract-cc-skills/).
 *
 * CLAUDE.md needs no handling — pi discovers it natively alongside AGENTS.md.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ConfigMode, claudeSourcesOn, configMode, projectConfigDir, userConfigDir } from "../lib/config-mode.ts";
import { claudeConfigDir, claudeUserDir } from "../lib/paths.ts";

import { BUNDLED_SKILLS_DIR } from "../lib/skill-scan.ts";

/**
 * `claudeDir` is Claude Code's config dir (honours CLAUDE_CONFIG_DIR), defaulting
 * to `home/.claude`; `home` itself is used only for the unrelated
 * `~/.agents/skills` cross-tool convention, which Claude Code does not relocate
 * via that env var.
 */
export function claudeResourcePaths(
	cwd: string,
	home: string,
	claudeDir: string = claudeUserDir(home),
	bundledSkillsDir?: string,
	mode: ConfigMode = configMode(),
): { skillPaths: string[]; promptPaths: string[] } {
	// Independent mode (lib/config-mode.ts) reads no Claude Code skill folder,
	// and its commands live under ~/.onecode and .onecode instead.
	const claude = claudeSourcesOn(mode);
	const candidates = {
		skillPaths: [
			...(claude ? [join(claudeDir, "skills")] : []),
			join(home, ".agents", "skills"),
			...(claude ? [join(cwd, ".claude", "skills")] : []),
			join(cwd, ".agents", "skills"),
			// The bundled catalog is listed LAST so it loses a name collision:
			// pi keeps the first-loaded skill for a given name, so a user or
			// project skill of the same name wins and the bundled one is the
			// fallback (see working-docs/decisions/skills-plugins.md).
			...(bundledSkillsDir ? [bundledSkillsDir] : []),
		],
		promptPaths: claude
			? [join(claudeDir, "commands"), join(cwd, ".claude", "commands")]
			: [join(userConfigDir(home, mode), "commands"), join(projectConfigDir(cwd, mode), "commands")],
	};
	return {
		skillPaths: candidates.skillPaths.filter((p) => existsSync(p)),
		promptPaths: candidates.promptPaths.filter((p) => existsSync(p)),
	};
}

export default function claudeCompatExtension(pi: ExtensionAPI) {
	pi.on("resources_discover", (event) => {
		return claudeResourcePaths(event.cwd, os.homedir(), claudeConfigDir(), BUNDLED_SKILLS_DIR);
	});
}
