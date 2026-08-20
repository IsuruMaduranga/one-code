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
 * When ONECODE.md files exist, this extension also emits a separate `# oneCodeMd`
 * block at CONTEXT_ORDER.oneCodeMd — after # claudeMd, so One Code-specific
 * instructions take precedence over CLAUDE.md. Keeping them out of # claudeMd
 * leaves that block byte-exact with Claude Code.
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
import { buildClaudeMdBlock, buildOneCodeBlock, discoverContextFiles, discoverOneCodeFiles } from "../lib/claude-context.ts";
import { projectMemoryDir, truncateIndex } from "../lib/memory.ts";
import { claudeConfigDir, oneCodeStateDir } from "../lib/paths.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";

const REMINDER_KEY = "claude-context";
const ONECODE_REMINDER_KEY = "one-code-context";

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
		// The # claudeMd block stays CLAUDE.md-only (byte-exact with Claude Code) —
		// ONECODE.md rides its own higher-precedence block below.
		const inner = buildClaudeMdBlock({
			contextFiles: discoverContextFiles({
				cwd: ctx.cwd,
				homeClaudeDir: claudeConfigDir(),
				home: os.homedir(),
			}),
			memoryIndex: readMemoryIndex(ctx.cwd),
			email: resolveEmail(ctx.cwd),
			// Per-session date, matching the cached Environment section; Claude Code's
			// block changes only across days too.
			date: new Date().toISOString().slice(0, 10),
		});
		if (inner) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: inner,
				scope: "every-turn",
				key: REMINDER_KEY,
				placement: "first-prepend",
				order: CONTEXT_ORDER.claudeMd,
				// Claude Code's claudeMd block ends `</system-reminder>\n\n` on the wire.
				suffix: "\n\n",
			});
		}

		// One Code's own instructions ride in a separate block AFTER # claudeMd, so
		// they take precedence over CLAUDE.md (higher order = closer to the user text).
		const oneCode = buildOneCodeBlock(
			discoverOneCodeFiles({ cwd: ctx.cwd, homeOneCodeDir: oneCodeStateDir(), home: os.homedir() }),
		);
		if (oneCode) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: oneCode,
				scope: "every-turn",
				key: ONECODE_REMINDER_KEY,
				placement: "first-prepend",
				order: CONTEXT_ORDER.oneCodeMd,
				suffix: "\n\n",
			});
		}
	});
}
