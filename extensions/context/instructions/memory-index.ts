/** Read the startup/compaction memory index without loading excluded or non-text files. */
import os from "node:os";
import { join } from "node:path";
import { readFileIfPresent } from "../../lib/context/instructions.ts";
import { autoMemoryEnabled } from "../../lib/context/auto-memory.ts";
import { projectMemoryDir } from "../../lib/context/memory.ts";
import { truncateIndex } from "../../lib/context/memory-content.ts";
import { allowedPath } from "../../lib/profile/sources.ts";

export function readMemoryIndex(cwd: string, home: string = os.homedir()): { path: string; content: string } | null {
	if (!autoMemoryEnabled(cwd)) return null;
	const path = join(projectMemoryDir(cwd, home), "MEMORY.md");
	if (!allowedPath(home)(path)) return null;
	const raw = readFileIfPresent(path);
	if (!raw?.trim() || raw.includes("\0")) return null;
	return { path, content: truncateIndex(raw) };
}
