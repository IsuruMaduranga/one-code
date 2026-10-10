/**
 * One Code's own settings files — the writable half of "own state, borrowed
 * config" (working-docs/decisions/memory-state.md). `~/.claude` is Claude Code's
 * directory and One Code only ever *reads* it; anything One Code persists that
 * looks like a settings key (its own `subagentModel` or the allow rules `/allow`
 * records) lands here instead, so One Code never mutates
 * Claude Code's config and a value that means nothing to Claude Code (a model it
 * cannot run, say) never ends up in Claude Code's file.
 *
 * Two scopes, mirroring the memory layout so a repo's worktrees and
 * subdirectories share one file:
 *   ~/.onecode/settings.json                          (user, global)
 *   ~/.onecode/projects/<slug>/settings.json          (per git repo, else cwd)
 *
 * The state root is resolved against an explicit `home` (not `os.homedir()`)
 * so callers that already thread `home` — the auto-mode and subagent settings
 * loaders — stay hermetic under a temp home in tests. `ONECODE_STATE_DIR` is
 * honoured exactly as `oneCodeStateDir()` does; when it is unset the root is
 * `<home>/.onecode`, which equals `oneCodeStateDir()` in production where
 * `home === os.homedir()`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-write.ts";
import { findProjectRoot } from "./git.ts";
import { projectSlug } from "./memory.ts";
import { oneCodeStateDir, tryRealpath } from "./paths.ts";

/** `~/.onecode/settings.json` — One Code's user-scope settings (writable). */
export function oneCodeSettingsPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(oneCodeStateDir(env, home), "settings.json");
}

/**
 * The project a per-repo setting belongs to: the git repository root when
 * there is one (shared by worktrees and subdirectories), else the cwd, through
 * symlinks so an aliased checkout is the same project.
 */
export function oneCodeProjectRoot(cwd: string): string {
	const root = findProjectRoot(cwd) ?? cwd;
	return tryRealpath(root) ?? root;
}

/**
 * `~/.onecode/projects/<slug>/settings.json` — One Code's per-repo settings
 * (writable), for `oneCodeProjectRoot`. The slug is the memory dir's
 * (`projectSlug`), but of the resolved root, where the memory dir slugs the
 * root as found. It is lossy (`my_app` and `my-app` share a file), so a setting
 * that grants trust records the root it was given for (claude-external-includes.ts).
 */
export function oneCodeProjectSettingsPath(cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
	return oneCodeProjectSettingsPathFor(oneCodeProjectRoot(cwd), home, env);
}

/** Resolve a project settings path without moving existing permission or trust state. */
export function oneCodeProjectSettingsPathFor(root: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
	const projects = join(oneCodeStateDir(env, home), "projects");
	const legacy = join(projects, root.replace(/[^A-Za-z0-9-]/g, "-"), "settings.json");
	if (existsSync(legacy)) return legacy;
	return join(projects, projectSlug(root), "settings.json");
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

/** User-only upgrade advice, enabled unless explicitly disabled in One Code's settings. */
export function readSuggestNewerModels(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const file = readJsonFile<{ suggestNewerModels?: unknown }>(oneCodeSettingsPath(home, env));
	return file?.suggestNewerModels !== false;
}

/** Claude Code's `workflowSizeGuideline` values: under 5, 10 or 50 agents, or no guideline. */
export type WorkflowSizeGuideline = "small" | "medium" | "large" | "unrestricted";

const WORKFLOW_SIZES: readonly WorkflowSizeGuideline[] = ["small", "medium", "large", "unrestricted"];

export interface WorkflowSettings {
	/** Whether the workflow tool is offered at all. */
	enabled: boolean;
	sizeGuideline: WorkflowSizeGuideline;
	/** True when a settings file set the guideline (the description says "configured"). */
	sizeConfigured: boolean;
}

interface WorkflowSettingsFile {
	enableWorkflows?: unknown;
	disableWorkflows?: unknown;
	workflowSizeGuideline?: unknown;
}

/**
 * The workflow settings Claude Code reads, from One Code's own files (user,
 * then the project file, which wins): `enableWorkflows` (default true),
 * `disableWorkflows` (true turns workflows off whatever `enableWorkflows`
 * says, as in Claude Code) and `workflowSizeGuideline` (default "medium"; an
 * unknown value is ignored). Read leniently: a malformed file is skipped.
 */
export function readWorkflowSettings(cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): WorkflowSettings {
	const files = [oneCodeSettingsPath(home, env), oneCodeProjectSettingsPath(cwd, home, env)].map((path) => readJsonFile<WorkflowSettingsFile>(path));
	let enable = true;
	let disable = false;
	let size: WorkflowSizeGuideline | undefined;
	for (const file of files) {
		if (!file || typeof file !== "object") continue;
		if (typeof file.enableWorkflows === "boolean") enable = file.enableWorkflows;
		if (file.disableWorkflows === true) disable = true;
		if (WORKFLOW_SIZES.includes(file.workflowSizeGuideline as WorkflowSizeGuideline)) size = file.workflowSizeGuideline as WorkflowSizeGuideline;
	}
	return { enabled: enable && !disable, sizeGuideline: size ?? "medium", sizeConfigured: size !== undefined };
}
