/**
 * memory extension — filesystem side of the auto-memory system (see
 * extensions/lib/memory.ts for the design and the prompt side).
 *
 * - session start: create the per-project memory directory (the system prompt
 *   promises the model "this directory already exists") and inject the
 *   MEMORY.md index — capped like Claude Code caps it — via the reminder queue.
 * - write into the memory dir: stamp bookkeeping frontmatter (node_type,
 *   originSessionId, modified) into the tool input *before* execution, so the
 *   file lands stamped and file-tracker observes the same bytes that are on
 *   disk. Edits are not stamped: Claude Code ties the stamp to writes, and an
 *   edit's input carries diffs, not the file.
 * - write/edit of MEMORY.md: check the load limits afterwards; near-limit
 *   nudges over the reminder queue, over-limit turns the result into an error
 *   (the write itself succeeded — the message says so), matching Claude Code.
 */

import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findGitRoot } from "../lib/git.ts";
import {
	INDEX_NEAR_LIMIT_REMINDER,
	INDEX_OVER_LIMIT_ERROR,
	indexLimitStatus,
	memoryDir,
	memoryIndexReminder,
	stampFrontmatter,
	truncateIndex,
} from "../lib/memory.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";

function inputPath(input: unknown, cwd: string): string | undefined {
	const raw = (input as { path?: unknown })?.path;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export default function memoryExtension(pi: ExtensionAPI) {
	let dir: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		// Like Claude Code: one memory dir per git repo (shared by worktrees and
		// subdirectories); outside a repo, per cwd.
		const candidate = memoryDir(os.homedir(), findGitRoot(ctx.cwd) ?? ctx.cwd);
		try {
			mkdirSync(candidate, { recursive: true });
		} catch {
			// Unwritable home (sandboxes, CI): the prompt section still renders,
			// and writes will surface their own errors to the model.
			return;
		}
		dir = candidate;

		const indexPath = join(dir, "MEMORY.md");
		let index = "";
		try {
			index = readFileSync(indexPath, "utf8");
		} catch {
			// No index yet — nothing to recall.
		}
		if (index.trim()) {
			pi.events.emit(REMINDER_CHANNEL, { text: memoryIndexReminder(indexPath, truncateIndex(index)) });
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" || !dir) return undefined;
		const path = inputPath(event.input, ctx.cwd);
		if (!path?.startsWith(dir + sep)) return undefined;
		const input = event.input as { content?: unknown };
		if (typeof input.content !== "string") return undefined;
		input.content = stampFrontmatter(input.content, ctx.sessionManager.getSessionId(), new Date().toISOString());
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError || !dir) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		if (inputPath(event.input, ctx.cwd) !== join(dir, "MEMORY.md")) return undefined;

		let index: string;
		try {
			index = readFileSync(join(dir, "MEMORY.md"), "utf8");
		} catch {
			return undefined;
		}
		const status = indexLimitStatus(index);
		if (status === "near") {
			pi.events.emit(REMINDER_CHANNEL, { text: INDEX_NEAR_LIMIT_REMINDER });
		} else if (status === "over") {
			return {
				content: [...(event.content ?? []), { type: "text", text: INDEX_OVER_LIMIT_ERROR }],
				isError: true,
			};
		}
		return undefined;
	});
}
