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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	INDEX_NEAR_LIMIT_REMINDER,
	INDEX_OVER_LIMIT_ERROR,
	indexLimitStatus,
	projectMemoryDir,
	stampFrontmatter,
} from "../lib/memory.ts";
import { claudeConfigDir } from "../lib/paths.ts";
import { tryReadFile } from "../lib/plugins.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { listMemoryFiles, prepareMemorySave } from "./files.ts";

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
		const candidate = projectMemoryDir(ctx.cwd);
		try {
			mkdirSync(candidate, { recursive: true });
		} catch {
			// Unwritable home (sandboxes, CI): the prompt section still renders,
			// and writes will surface their own errors to the model.
			return;
		}
		dir = candidate;

		// The MEMORY.md index is injected by the claude-context extension, folded
		// into the `# claudeMd` block exactly as Claude Code does — not as a
		// separate reminder here. This extension owns the directory and the
		// write-time stamping / limit checks below.
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

	// ---- /memory: view or edit CLAUDE.md + memory files ---------------------
	// Claude Code's `/memory`: pick a memory-related file and edit it. Interactive
	// only — driven through pi's select + editor dialogs; a create-on-save target
	// (a not-yet-existing CLAUDE.md) is written when the user saves non-empty text.
	pi.registerCommand("memory", {
		description: "View or edit CLAUDE.md and memory files",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/memory needs an interactive terminal to pick and edit a file.", "warning");
				return;
			}
			const files = listMemoryFiles({ cwd: ctx.cwd, homeClaudeDir: claudeConfigDir() });
			// Key the picker by its rendered label so the selection maps straight
			// back to an entry — no parallel array / indexOf to keep in sync.
			const byLabel = new Map(files.map((f) => [f.displayLabel, f]));
			const picked = await ctx.ui.select("Edit memory / CLAUDE.md", [...byLabel.keys()]);
			if (picked === undefined) return;
			const entry = byLabel.get(picked);
			if (!entry) return;

			const current = tryReadFile(entry.path) ?? "";
			const edited = await ctx.ui.editor(`Editing ${entry.path}`, current);
			if (edited === undefined || edited === current) return;

			// Route through the same treatment a model write to the memory dir gets:
			// frontmatter stamping + the MEMORY.md load-limit warning (files.ts).
			const plan = prepareMemorySave({
				path: entry.path,
				content: edited,
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				nowIso: new Date().toISOString(),
			});
			try {
				mkdirSync(dirname(entry.path), { recursive: true });
				writeFileSync(entry.path, plan.content);
				ctx.ui.notify(`Saved ${entry.path}`, "info");
				if (plan.warning) ctx.ui.notify(plan.warning, "warning");
			} catch (error) {
				ctx.ui.notify(`Could not save ${entry.path}: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});
}
