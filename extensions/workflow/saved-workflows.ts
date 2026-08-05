/**
 * Saved-workflow discovery (pure). Named workflow scripts live in
 * `.claude/workflows/` (project) and `~/.claude/workflows/` (user) as `.js`
 * files, matching Claude Code's layout; the file's basename is the invocation
 * name and the leading `export const meta` supplies the description. Project
 * definitions shadow user ones of the same name.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseWorkflowScript } from "./script-source.ts";
import type { SavedWorkflow } from "./types.ts";

function scanDir(dir: string, source: SavedWorkflow["source"]): SavedWorkflow[] {
	if (!existsSync(dir)) return [];
	const found: SavedWorkflow[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
		const path = join(dir, file);
		const workflow: SavedWorkflow = { name: basename(file).replace(/\.(js|mjs)$/, ""), path, source };
		try {
			workflow.meta = parseWorkflowScript(readFileSync(path, "utf8")).meta;
		} catch {
			// Listed anyway; the parse error surfaces if the user runs it.
		}
		found.push(workflow);
	}
	return found;
}

export function workflowDirs(cwd: string, home: string): { project: string; user: string } {
	return { project: join(cwd, ".claude", "workflows"), user: join(home, ".claude", "workflows") };
}

export function discoverSavedWorkflows(cwd: string, home: string): SavedWorkflow[] {
	const dirs = workflowDirs(cwd, home);
	const project = scanDir(dirs.project, "project");
	const names = new Set(project.map((w) => w.name));
	const user = scanDir(dirs.user, "user").filter((w) => !names.has(w.name));
	return [...project, ...user];
}

export function findSavedWorkflow(cwd: string, home: string, name: string): SavedWorkflow | undefined {
	return discoverSavedWorkflows(cwd, home).find((w) => w.name === name);
}
