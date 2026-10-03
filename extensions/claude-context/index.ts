/**
 * claude-context extension — assembles Claude Code's three first-message context
 * reminders and queues them `first-prepend` (lib/claude-context.ts has the
 * formats): the instructions block (CLAUDE.md files + MEMORY.md index) at
 * CONTEXT_ORDER.claudeMd, the context block (userEmail + the git snapshot) at
 * CONTEXT_ORDER.context, and the date at CONTEXT_ORDER.date, which on a model
 * that takes a mid-conversation system message rides that message instead
 * (system-reminder, lib/system-role.ts). They ride the reminder queue
 * (transient per-request via pi's `context` event), so they never persist to
 * the session and never double up on resume.
 *
 * When ONECODE.md files exist, this extension also emits a separate `# oneCodeMd`
 * block at CONTEXT_ORDER.oneCodeMd — after the instructions block, so One
 * Code-specific instructions take precedence over CLAUDE.md. Keeping them out
 * of that block leaves it byte-exact with Claude Code.
 *
 * Paths are re-derived from home/cwd here rather than shared with the memory
 * extension (jiti gives each extension its own module instance).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildClaudeMdBlock,
	buildContextBlock,
	buildOneCodeBlock,
	dateBlock,
	dateChangeReminder,
	discoverContextFiles,
	discoverOneCodeFiles,
	localDate,
} from "../lib/claude-context.ts";
import { collectGitStatus, GIT_SNAPSHOT_OWNER_CHANNEL } from "../lib/git-status.ts";
import { projectMemoryDir, truncateIndex } from "../lib/memory.ts";
import { claudeConfigDir, oneCodeStateDir } from "../lib/paths.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { HARNESS_GIT_CONFIG } from "../lib/git.ts";

const REMINDER_KEY = "claude-context";
const ONECODE_REMINDER_KEY = "one-code-context";
const CONTEXT_REMINDER_KEY = "claude-context-context";
const DATE_REMINDER_KEY = "claude-context-date";

/** The account email Claude Code stamps as `# userEmail`. git config is our proxy. */
function resolveEmail(cwd: string): string | null {
	try {
		const email = execFileSync("git", [...HARNESS_GIT_CONFIG, "config", "user.email"], { cwd, encoding: "utf8" }).trim();
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
	/** The account email stand-in, resolved at session start. */
	let email: string | null = null;
	/** Claude Code's git snapshot, taken once at the conversation's first turn; undefined until then. */
	let gitStatus: string | null | undefined;
	/**
	 * Only the main session takes the snapshot, as before it moved here: its
	 * system-prompt extension (never loaded in a child) claims it at session
	 * start. A subagent or workflow agent would otherwise run its own git
	 * commands, synchronously on the shared event loop, for every child.
	 */
	let takesGitSnapshot = false;
	pi.events.on(GIT_SNAPSHOT_OWNER_CHANNEL, () => {
		takesGitSnapshot = true;
	});
	/** The date the date reminder carries. */
	let blockDate = "";
	/** The date the model was last told: the reminder's, or a later date-change notice's. */
	let shownDate = "";

	const emitDate = (date: string) => {
		blockDate = date;
		shownDate = date;
		pi.events.emit(REMINDER_CHANNEL, {
			text: dateBlock(date),
			scope: "every-turn",
			key: DATE_REMINDER_KEY,
			placement: "first-prepend",
			order: CONTEXT_ORDER.date,
		});
	};

	pi.on("session_start", (_event, ctx) => {
		// The instructions block carries the CLAUDE.md family, falling back to a
		// directory's AGENTS.md when it has no CLAUDE.md (CLAUDE.md > AGENTS.md). It
		// stays byte-exact with Claude Code wherever CLAUDE.md is present, since
		// AGENTS.md only fills in for a missing one. ONECODE.md rides its own
		// higher-precedence block below.
		const instructions = buildClaudeMdBlock({
			contextFiles: discoverContextFiles({
				cwd: ctx.cwd,
				homeClaudeDir: claudeConfigDir(),
				agentsFallback: true,
				home: os.homedir(),
			}),
			memoryIndex: readMemoryIndex(ctx.cwd),
		});
		if (instructions) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: instructions,
				scope: "every-turn",
				key: REMINDER_KEY,
				placement: "first-prepend",
				order: CONTEXT_ORDER.claudeMd,
			});
		}
		email = resolveEmail(ctx.cwd);
		// /clear re-fires session_start: the next conversation takes its own snapshot.
		gitStatus = undefined;
		// The user's local date, taken once: the reminder is frozen after the first
		// request, so a later date rides a one-shot (before_agent_start below).
		emitDate(localDate());

		// One Code's own instructions ride in a separate block AFTER the instructions
		// block, so they take precedence over CLAUDE.md (higher order = closer to the user text).
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
			});
		}
	});

	// Claude Code snapshots git "at the start of the conversation": on the first
	// turn, typed or opened from idle, never in session_start, so the several
	// synchronous git spawns never delay the prompt opening (findings §15). The
	// clip note names the shell tool the model has (PowerShell only without bash).
	pi.on("turn_start", (_event, ctx) => {
		if (gitStatus !== undefined) return;
		const tools = pi.getActiveTools();
		const shellTool = tools.includes("powershell") && !tools.includes("bash") ? "powershell" : "bash";
		gitStatus = takesGitSnapshot ? collectGitStatus(ctx.cwd, undefined, shellTool) : null;
		const context = buildContextBlock({ email, gitStatus });
		if (!context) return;
		pi.events.emit(REMINDER_CHANNEL, {
			text: context,
			scope: "every-turn",
			key: CONTEXT_REMINDER_KEY,
			placement: "first-prepend",
			order: CONTEXT_ORDER.context,
		});
	});

	// A session that crosses local midnight learns the new date on its next
	// turn, as a one-shot on that turn's prompt (Claude Code's notice), so the
	// frozen reminder on message 1 and the cached prefix stay as they are.
	pi.on("before_agent_start", () => {
		if (!blockDate) return;
		const today = localDate();
		if (today === shownDate) return;
		shownDate = today;
		pi.events.emit(REMINDER_CHANNEL, { text: dateChangeReminder(today) });
	});

	// A compaction starts a new prefix, and the notice may have ridden a message
	// it folded away: rebuild the reminder with today's date while it costs nothing.
	pi.on("session_compact", () => {
		const today = localDate();
		if (today !== blockDate) emitDate(today);
	});
}
