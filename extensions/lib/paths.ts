/**
 * Where One Code reads and writes (pure).
 *
 * The policy is "own state, borrowed config": `~/.claude` is Claude Code's
 * directory and One Code treats it as a read-only compatibility surface
 * (settings, skills, agents, plugins, CLAUDE.md); everything One Code
 * *generates* — plan files, and over time the rest of its state — lands in
 * One Code's own `~/.one-code`, so neither product's artifacts mingle with the
 * other's. See "Own state, borrowed config" in docs/decisions.md.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code's config dir — the compat surface One Code reads, never writes.
 * Honours CLAUDE_CONFIG_DIR the way Claude Code itself does.
 */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
	return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * One Code's own state dir — everything One Code generates goes here. `home`
 * defaults to the real home; callers that already thread a `home` (the settings
 * loaders, hermetic in tests) pass it so the root stays under that home when
 * `ONE_CODE_STATE_DIR` is unset.
 */
export function oneCodeStateDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	return env.ONE_CODE_STATE_DIR || join(home, ".one-code");
}
