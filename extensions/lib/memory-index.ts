/** Read the startup/compaction memory index without loading excluded or non-text files. */
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { isClaudeLocation } from "./claude-context.ts";
import { MAX_INSTRUCTION_BYTES } from "./claude-rules.ts";
import { claudeSourcesOn } from "./config-mode.ts";
import { projectMemoryDir, truncateIndex } from "./memory.ts";
import { claudeUserDir } from "./paths.ts";

export function readMemoryIndex(cwd: string, home: string = os.homedir()): { path: string; content: string } | null {
	const path = join(projectMemoryDir(cwd, home), "MEMORY.md");
	if (!claudeSourcesOn() && isClaudeLocation(path, claudeUserDir(home))) return null;
	try {
		// A FIFO can block the shared event loop indefinitely before any bytes arrive.
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES) return null;
		const raw = readFileSync(path, "utf8");
		if (!raw.trim() || raw.includes("\0")) return null;
		return { path, content: truncateIndex(raw) };
	} catch {
		// Missing or unreadable indexes carry no context, as at ordinary startup.
		return null;
	}
}
