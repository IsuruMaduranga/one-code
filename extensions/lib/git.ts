/** Shared git helpers — pure functions only (safe to import across extensions). */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function findGitRoot(startDir: string): string | undefined {
	let dir = startDir;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
