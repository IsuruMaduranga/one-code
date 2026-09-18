/**
 * Environment facts for the system prompt's # Environment section.
 * Collected once per (cwd, model) and cached so the prompt stays byte-stable
 * across turns — required for provider prompt caching to pay off. Nothing
 * time-valued belongs here: the date rides Claude Code's `# currentDate` line
 * in the first-message reminder (claude-context), never the system prompt
 * (Claude Code's own prompt has no date line; a cached one went stale at
 * midnight — CACHE-REVIEW-2026-09-04 L2).
 */

import os from "node:os";
import { findGitRoot } from "../lib/git.ts";
import { projectMemoryDir } from "../lib/memory.ts";

export interface EnvironmentInfo {
	cwd: string;
	isGitRepo: boolean;
	platform: string;
	osVersion: string;
	shell: string;
	modelLine: string;
	/** Per-project auto-memory directory; the memory extension guarantees it exists. */
	memoryDir: string;
}

/**
 * The `Shell:` value Claude Code prints: the basename of `SHELL`, else of
 * `COMSPEC` (Windows, where `SHELL` is unset outside Git Bash), with a `.exe`
 * suffix stripped and either path separator honoured — `cmd`, not `cmd.exe`.
 */
export function shellName(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.SHELL || env.COMSPEC;
	if (!raw) return "unknown";
	const base = raw.split(/[\\/]/).pop() ?? "";
	if (!base) return "unknown";
	return base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
}

export function collectEnvironment(cwd: string, modelLine: string): EnvironmentInfo {
	const gitRoot = findGitRoot(cwd);
	return {
		cwd,
		isGitRepo: gitRoot !== undefined,
		platform: process.platform,
		osVersion: `${os.type()} ${os.release()}`,
		shell: shellName(),
		modelLine,
		memoryDir: projectMemoryDir(cwd, os.homedir()),
	};
}
