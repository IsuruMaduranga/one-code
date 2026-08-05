/**
 * Environment facts for the system prompt's # Environment section.
 * Collected once per (cwd, model) and cached so the prompt stays byte-stable
 * across turns — required for provider prompt caching to pay off.
 */

import os from "node:os";
import { findGitRoot } from "../lib/git.ts";
import { memoryDir } from "../lib/memory.ts";

export interface EnvironmentInfo {
	cwd: string;
	isGitRepo: boolean;
	platform: string;
	osVersion: string;
	shell: string;
	date: string;
	modelLine: string;
	/** Per-project auto-memory directory; the memory extension guarantees it exists. */
	memoryDir: string;
}

export function collectEnvironment(cwd: string, modelLine: string): EnvironmentInfo {
	const gitRoot = findGitRoot(cwd);
	return {
		cwd,
		isGitRepo: gitRoot !== undefined,
		platform: process.platform,
		osVersion: `${os.type()} ${os.release()}`,
		shell: process.env.SHELL ? (process.env.SHELL.split("/").pop() ?? "unknown") : "unknown",
		date: new Date().toISOString().slice(0, 10),
		modelLine,
		memoryDir: memoryDir(os.homedir(), gitRoot ?? cwd),
	};
}
