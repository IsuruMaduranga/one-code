/** Read the startup/compaction memory index without loading excluded or non-text files. */
import os from "node:os";
import { join } from "node:path";
import { isClaudeLocation, readFileIfPresent } from "./claude-context.ts";
import { claudeSourcesOn } from "./config-mode.ts";
import { projectMemoryDir } from "./memory.ts";
import { truncateIndex } from "./memory-content.ts";
import { claudeUserDir } from "./paths.ts";

export function readMemoryIndex(cwd: string, home: string = os.homedir()): { path: string; content: string } | null {
	const path = join(projectMemoryDir(cwd, home), "MEMORY.md");
	if (!claudeSourcesOn() && isClaudeLocation(path, claudeUserDir(home))) return null;
	const raw = readFileIfPresent(path);
	if (!raw?.trim() || raw.includes("\0")) return null;
	return { path, content: truncateIndex(raw) };
}
