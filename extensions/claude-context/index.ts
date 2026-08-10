/**
 * claude-context extension — assembles Claude Code's `# claudeMd` context block
 * (CLAUDE.md files + MEMORY.md index + userEmail + currentDate) and injects it as
 * a `<system-reminder>` at the front of the first user message, matching Claude
 * Code byte-for-byte (see extensions/lib/claude-context.ts for the format).
 *
 * The block is emitted `first-prepend` at CONTEXT_ORDER.claudeMd — last in Claude
 * Code's context stack (deferred tools → agents → MCP → skills → claudeMd), just
 * before the user's text. It rides the reminder queue (transient per-request via
 * pi's `context` event), so it never persists to the session and never doubles up
 * on resume.
 *
 * Paths are re-derived from home/cwd here rather than shared with the memory
 * extension (jiti gives each extension its own module instance). CLAUDE.md is no
 * longer put in the system prompt, and MEMORY.md is no longer a separate reminder
 * — both fold into this one block, as Claude Code does.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildClaudeMdBlock, discoverContextFiles } from "../lib/claude-context.ts";
import { projectMemoryDir, truncateIndex } from "../lib/memory.ts";
import { claudeConfigDir } from "../lib/paths.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";

const REMINDER_KEY = "claude-context";

/** The account email Claude Code stamps as `# userEmail`. git config is our proxy. */
function resolveEmail(cwd: string): string | null {
	try {
		const email = execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8" }).trim();
		if (email) return email;
	} catch {
		// no git / no config — fall through
	}
	return process.env.GIT_AUTHOR_EMAIL?.trim() || process.env.EMAIL?.trim() || null;
}

function readMemoryIndex(cwd: string): { path: string; content: string } | null {
	const dir = projectMemoryDir(cwd, os.homedir());
	const path = join(dir, "MEMORY.md");
	try {
		const raw = readFileSync(path, "utf8");
		if (!raw.trim()) return null;
		return { path, content: truncateIndex(raw) };
	} catch {
		return null;
	}
}

export default function claudeContextExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const inner = buildClaudeMdBlock({
			contextFiles: discoverContextFiles({
				cwd: ctx.cwd,
				homeClaudeDir: claudeConfigDir(),
			}),
			memoryIndex: readMemoryIndex(ctx.cwd),
			email: resolveEmail(ctx.cwd),
			// Per-session date, matching the cached Environment section; Claude Code's
			// block changes only across days too.
			date: new Date().toISOString().slice(0, 10),
		});
		if (!inner) return;

		pi.events.emit(REMINDER_CHANNEL, {
			text: inner,
			scope: "every-turn",
			key: REMINDER_KEY,
			placement: "first-prepend",
			order: CONTEXT_ORDER.claudeMd,
			// Claude Code's claudeMd block ends `</system-reminder>\n\n` on the wire.
			suffix: "\n\n",
		});
	});
}
