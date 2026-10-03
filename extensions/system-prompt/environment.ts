/**
 * Environment facts for Claude Code's `# Environment` block
 * (lib/environment-block.ts) and the memory directory the system prompt names.
 * Collected once per cwd and cached so the text stays byte-stable across turns
 * — required for provider prompt caching to pay off. Nothing time-valued
 * belongs here: the date rides its own first-message reminder (claude-context),
 * never the system prompt (a cached one went stale at midnight —
 * CACHE-REVIEW-2026-09-04 L2).
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
	/** Per-project auto-memory directory; the memory extension guarantees it exists. */
	memoryDir: string;
	/** The workspace directories as the session started (lib/workspace-channel.ts); listed only when there are some. */
	workspaceDirs?: string[];
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

export function collectEnvironment(cwd: string): EnvironmentInfo {
	const gitRoot = findGitRoot(cwd);
	return {
		cwd,
		isGitRepo: gitRoot !== undefined,
		platform: process.platform,
		osVersion: `${os.type()} ${os.release()}`,
		shell: shellName(),
		memoryDir: projectMemoryDir(cwd, os.homedir()),
	};
}
