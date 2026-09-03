/**
 * Where One Code reads and writes (pure).
 *
 * The policy is "own state, borrowed config": `~/.claude` is Claude Code's
 * directory and One Code treats it as a read-only compatibility surface
 * (settings, skills, agents, plugins, CLAUDE.md); everything One Code
 * *generates* — plan files, and over time the rest of its state — lands in
 * One Code's own `~/.onecode`, so neither product's artifacts mingle with the
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
 * The user-scope Claude Code dir for a given `home` — `claudeConfigDir` for
 * callers that thread a `home` (tests, `~`-expansion). `CLAUDE_CONFIG_DIR`
 * still wins, exactly as Claude Code honours it; project-scope `<cwd>/.claude`
 * is never relocated by that variable, so callers keep spelling that one out.
 */
export function claudeUserDir(home: string, env: Record<string, string | undefined> = process.env): string {
	return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

/**
 * Claude Code's `.claude.json` (MCP servers, onboarding state): beside the
 * home dir by default, and INSIDE `CLAUDE_CONFIG_DIR` when that is set — the
 * one user-scope file that does not live under `~/.claude`.
 */
export function claudeJsonPath(home: string, env: Record<string, string | undefined> = process.env): string {
	return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
}

/**
 * Shell-style `~` expansion with one semantics everywhere: a bare `~` is
 * `home`, `~/x` is under it, and `~user` is left alone (no other user's home is
 * ever guessed). Anything else is returned unchanged.
 */
export function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/**
 * One Code's own state dir — everything One Code generates goes here. `home`
 * defaults to the real home; callers that already thread a `home` (the settings
 * loaders, hermetic in tests) pass it so the root stays under that home when
 * `ONECODE_STATE_DIR` is unset.
 */
export function oneCodeStateDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	return env.ONECODE_STATE_DIR || join(home, ".onecode");
}
