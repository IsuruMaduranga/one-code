/**
 * Where pincer reads and writes (pure).
 *
 * The policy is "own state, borrowed config": `~/.claude` is Claude Code's
 * directory and pincer treats it as a read-only compatibility surface
 * (settings, skills, agents, plugins, CLAUDE.md); everything pincer
 * *generates* — plan files, and over time the rest of its state — lands in
 * pincer's own `~/.pincer`, so neither product's artifacts mingle with the
 * other's. See "Own state, borrowed config" in docs/decisions.md.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code's config dir — the compat surface pincer reads, never writes.
 * Honours CLAUDE_CONFIG_DIR the way Claude Code itself does.
 */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
	return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** pincer's own state dir — everything pincer generates goes here. */
export function pincerStateDir(env: Record<string, string | undefined> = process.env): string {
	return env.PINCER_STATE_DIR || join(homedir(), ".pincer");
}
