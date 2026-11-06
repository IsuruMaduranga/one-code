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
import { claudeUserDir, isClaudeLocation } from "../../extensions/lib/paths.ts";
import type { SourceProvider } from "../../extensions/lib/sources.ts";
import { claudeCodeInstructionView } from "./instructions.ts";

export const sources: SourceProvider = {
	open({ home }) {
		if (!claudeSourcesOn()) {
			const homeClaudeDir = claudeUserDir(home);
			return { allowPath: (path) => !isClaudeLocation(path, homeClaudeDir) };
		}
		return { instructions: claudeCodeInstructionView(home) };
	},
};
