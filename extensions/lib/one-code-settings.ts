/**
 * One Code's own settings files — the writable half of "own state, borrowed
 * config" (docs/decisions/memory-state.md). `~/.claude` is Claude Code's
 * directory and One Code only ever *reads* it; anything One Code persists that
 * looks like a settings key (its own `subagentModel` / `autoMode.classifierModel`,
 * the allow rules `/allow` records) lands here instead, so One Code never mutates
 * Claude Code's config and a value that means nothing to Claude Code (a model it
 * cannot run, say) never ends up in Claude Code's file.
 *
 * Two scopes, mirroring the memory layout so a repo's worktrees and
 * subdirectories share one file:
 *   ~/.one-code/settings.json                          (user, global)
 *   ~/.one-code/projects/<slug>/settings.json          (per git repo, else cwd)
 *
 * The state root is resolved against an explicit `home` (not `os.homedir()`)
 * so callers that already thread `home` — the auto-mode and subagent settings
 * loaders — stay hermetic under a temp home in tests. `ONE_CODE_STATE_DIR` is
 * honoured exactly as `oneCodeStateDir()` does; when it is unset the root is
 * `<home>/.one-code`, which equals `oneCodeStateDir()` in production where
 * `home === os.homedir()`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-write.ts";
import { findGitRoot } from "./git.ts";
import { projectSlug } from "./memory.ts";
import { oneCodeStateDir } from "./paths.ts";

/** `~/.one-code/settings.json` — One Code's user-scope settings (writable). */
export function oneCodeSettingsPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(oneCodeStateDir(env, home), "settings.json");
}

/**
 * `~/.one-code/projects/<slug>/settings.json` — One Code's per-repo settings
 * (writable). Keyed by the git repository root when there is one (shared by
 * worktrees and subdirectories), else the cwd — the same slug the memory dir uses.
 */
export function oneCodeProjectSettingsPath(cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(oneCodeStateDir(env, home), "projects", projectSlug(findGitRoot(cwd) ?? cwd), "settings.json");
}

/**
 * Read a JSON settings object for a read-modify-write. Throws on a malformed
 * file rather than returning `{}`: a lenient read merely skips a setting, but a
 * lenient write would replace the whole file with only the caller's keys.
 * A missing file is an empty object (the writer creates it).
 */
export function readSettingsForWrite(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path}: root must be a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

/** Write a settings object atomically (temp sibling + rename), creating parent
 * directories as needed — a reader never sees a half-written settings file. */
export function writeSettings(path: string, file: Record<string, unknown>): void {
	writeJsonAtomic(path, file);
}
