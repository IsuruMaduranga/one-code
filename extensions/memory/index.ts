/**
 * memory extension — filesystem side of the auto-memory system (see
 * extensions/lib/memory.ts for the design and the prompt side).
 *
 * - session start: create the per-project memory directory (the system prompt
 *   promises the model "this directory already exists") and inject the
 *   MEMORY.md index — capped like Claude Code caps it — via the reminder queue.
 *   Also raise Claude Code's startup over-limit warning for any loaded context
 *   file (CLAUDE.md family, AGENTS.md, ONECODE.md) past the char limit.
 * - write into the memory dir: stamp bookkeeping frontmatter (node_type,
 *   originSessionId, modified) into the tool input *before* execution, so the
 *   file lands stamped and file-tracker observes the same bytes that are on
 *   disk. Edits are not stamped: Claude Code ties the stamp to writes, and an
 *   edit's input carries diffs, not the file.
 * - write/edit of MEMORY.md: check the load limits afterwards; near-limit
 *   nudges over the reminder queue, over-limit turns the result into an error
 *   (the write itself succeeded — the message says so), matching Claude Code.
 * - /memory: Claude Code's Memory picker — a panel of the CLAUDE.md-family /
 *   AGENTS.md / ONECODE.md files plus "Open auto-memory folder"; the selection
 *   opens in the external $EDITOR/$VISUAL (or the OS opener), as CC does.
 */

import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	claudeMdLimitWarning,
	combinedLimitWarning,
	INDEX_NEAR_LIMIT_REMINDER,
	INDEX_OVER_LIMIT_ERROR,
	indexLimitStatus,
	projectMemoryDir,
	stampFrontmatter,
} from "../lib/memory.ts";
import { claudeConfigDir, oneCodeStateDir } from "../lib/paths.ts";
import { tryReadFile } from "../lib/plugins.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { boundedDockHeight, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { buildMemoryEntries, entryName, type MemoryEntry } from "./entries.ts";
import { openPath } from "./open-external.ts";
import { applyMemoryKey, decodeMemoryKey, initialMemoryState, renderMemoryPanel } from "./panel.ts";

const MEMORY_PANEL_MAX_HEIGHT = 20;

function inputPath(input: unknown, cwd: string): string | undefined {
	const raw = (input as { path?: unknown })?.path;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** All the panel/warning entries for `cwd`, from One Code's real state dirs. */
function memoryEntriesFor(cwd: string): MemoryEntry[] {
	return buildMemoryEntries({
		cwd,
		home: os.homedir(),
		homeClaudeDir: claudeConfigDir(),
		homeOneCodeDir: oneCodeStateDir(),
		memoryDir: projectMemoryDir(cwd),
	});
}

export default function memoryExtension(pi: ExtensionAPI) {
	let dir: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		const candidate = projectMemoryDir(ctx.cwd);

		// Claude Code's startup warning: an instruction file over the char limit
		// bloats every turn's context. Warn once, pointing at /memory to trim it.
		// Also warn when several files each fit but together blow the budget —
		// suppressed if a single file already fired, so a lone big file isn't
		// reported twice.
		if (ctx.hasUI) {
			let total = 0;
			let anyPerFile = false;
			for (const entry of memoryEntriesFor(ctx.cwd)) {
				if (entry.kind !== "file" || !entry.exists) continue;
				const content = tryReadFile(entry.path);
				if (content == null) continue;
				total += content.length;
				const warning = claudeMdLimitWarning(entryName(entry), content.length);
				if (warning) {
					anyPerFile = true;
					ctx.ui.notify(warning, "warning");
				}
			}
			if (!anyPerFile) {
				const combined = combinedLimitWarning(total);
				if (combined) ctx.ui.notify(combined, "warning");
			}
		}

		// Like Claude Code: one memory dir per git repo (shared by worktrees and
		// subdirectories); outside a repo, per cwd.
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

	// ---- /memory: Claude Code's Memory picker --------------------------------
	// Pick a memory-related file (or the auto-memory folder) and open it in the
	// external editor, matching CC. Pure panel logic lives in ./panel.ts.
	pi.registerCommand("memory", {
		description: "View or edit CLAUDE.md and memory files",
		handler: async (_args, ctx) => {
			const entries = memoryEntriesFor(ctx.cwd);
			if (!ctx.hasUI) {
				const lines = entries.map(
					(e, i) => `${i + 1}. ${e.title}${e.description ? ` — ${e.description}` : ""}  [${e.path}]`,
				);
				ctx.ui.notify(`Memory / CLAUDE.md files:\n${lines.join("\n")}`, "info");
				return;
			}
			const chosen = await openMemoryPanel(ctx, entries);
			if (!chosen) return;
			const result = await openPath(chosen.path, chosen.kind);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			if (result.ok && result.hint) ctx.ui.notify(result.hint, "info");
		},
	});
}

/** Show the Memory panel as a focused overlay; resolve to the chosen entry or null. */
function openMemoryPanel(ctx: ExtensionContext, entries: MemoryEntry[]): Promise<MemoryEntry | null> {
	return ctx.ui.custom<MemoryEntry | null>((tui, theme, _keybindings, done) => {
		const paint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme) };
		const state = initialMemoryState();
		let cache: { width: number; lines: string[] } | undefined;
		const repaint = () => {
			cache = undefined;
			tui.requestRender();
		};
		return {
			render: (width: number) => {
				if (cache?.width === width) return cache.lines;
				const termRows = (tui as { terminal: { rows: number } }).terminal.rows;
				const height = boundedDockHeight(termRows, MEMORY_PANEL_MAX_HEIGHT);
				const lines = renderMemoryPanel({ state, entries, width, height }, paint).map((line) =>
					truncateLine(line, width),
				);
				cache = { width, lines };
				return lines;
			},
			handleInput: (data: string) => {
				const key = decodeMemoryKey(data);
				if (!key) return;
				const effect = applyMemoryKey(state, key, entries);
				if (effect?.kind === "close") {
					done(null);
					return;
				}
				if (effect?.kind === "open") {
					done(effect.entry);
					return;
				}
				repaint();
			},
			invalidate: () => {
				cache = undefined;
			},
		};
	});
}
