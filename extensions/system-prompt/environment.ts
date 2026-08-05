/**
 * Environment facts for the system prompt's # Environment section.
 * Collected once per (cwd, model) and cached so the prompt stays byte-stable
 * across turns — required for provider prompt caching to pay off.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

export interface EnvironmentInfo {
	cwd: string;
	isGitRepo: boolean;
	platform: string;
	osVersion: string;
	shell: string;
	date: string;
	modelLine: string;
}

export function findGitRoot(startDir: string): string | undefined {
	let dir = startDir;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function collectEnvironment(cwd: string, modelLine: string): EnvironmentInfo {
	return {
		cwd,
		isGitRepo: findGitRoot(cwd) !== undefined,
		platform: process.platform,
		osVersion: `${os.type()} ${os.release()}`,
		shell: process.env.SHELL ? (process.env.SHELL.split("/").pop() ?? "unknown") : "unknown",
		date: new Date().toISOString().slice(0, 10),
		modelLine,
	};
}
