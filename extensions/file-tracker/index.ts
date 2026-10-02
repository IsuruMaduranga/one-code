/**
 * file-tracker extension — Claude Code's read-before-write discipline.
 *
 * - `edit`/`write`/`notebook_edit` on a file that exists but was never read is
 *   blocked with an instruction to read it first.
 * - An edit to a file that changed since we last saw it is blocked, so the model
 *   cannot overwrite someone else's change.
 * - Files that change out of band are reported in a `<system-reminder>` with the
 *   new content around the change, line-numbered.
 * - After a compaction, the files read or written most recently come back as
 *   Claude Code brings them back: the contents of a small one, a note to read
 *   a large one again (`restore.ts`), and the read state is cleared.
 *
 * Tracking is by content, not by tool call, which is what makes it catch writes
 * that went through bash and never touched an intercepted tool.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionContext, type SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { pathArgument } from "../auto-mode/paths.ts";
import { collectImportedPaths, discoverContextFilePaths } from "../lib/claude-context.ts";
import { inContextEntries, latestCompaction } from "../lib/compaction-boundary.ts";
import { projectMemoryDir } from "../lib/memory.ts";
import { comparablePath, claudeConfigDir } from "../lib/paths.ts";
import { estimateTextTokens } from "../lib/pi-ai-estimate.ts";
import { planFileOnBranch } from "../lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "../lib/reminders.ts";
import { resolveToolPath } from "../lib/tool-path.ts";
import { parseRules, ruleMatches } from "../permissions/matcher.ts";
import { loadPermissionSettings } from "../permissions/settings.ts";
import { keptReadPaths, lastTouchesOnBranch, pathsReadOnBranch } from "./replay.ts";
import { type RestoredRead, restoreBlocks, restoreCandidates } from "./restore.ts";
import {
	describeChanges,
	EXTERNAL_CHANGE_REMINDER,
	type FileStamp,
	FileTracker,
	STALE_REASON,
	UNREAD_REASON,
} from "./tracker.ts";

const GUARDED_TOOLS = new Set(["edit", "write", "notebook_edit"]);
const READ_TOOLS = new Set(["read", "notebook_edit"]);
/**
 * At most this many changed files get the full excerpt reminder per turn; the
 * rest are named in one line. A formatter pass or `git checkout` touching
 * dozens of tracked files otherwise produced dozens of 40-line blocks (review T8).
 */
const DETAILED_CHANGE_REMINDERS_PER_TURN = 5;

function readIfPresent(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		// Binary or unreadable: not something we can reason about, so don't guard it.
		return undefined;
	}
}

/** The file's disk stamp, or undefined when it is gone (or not a plain file we could stat). */
function statIfPresent(path: string): FileStamp | undefined {
	try {
		const stat = statSync(path);
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return undefined;
	}
}

/** Observe a file's current content together with the stamp it was read at, and return that stamp. */
function observeFromDisk(tracker: FileTracker, path: string): FileStamp | undefined {
	const stamp = statIfPresent(path);
	const current = readIfPresent(path);
	if (current === undefined) tracker.forget(path);
	else tracker.observe(path, current, Date.now(), stamp);
	return stamp;
}

function pathOf(input: unknown, cwd: string): string | undefined {
	// Share the field-name knowledge with the auto-mode gates: `path` for pi's
	// built-ins, `file_path`/`notebook_path` for Claude Code-shaped calls. A
	// notebook_edit using only `notebook_path` would otherwise bypass the
	// read-before-write guard (code-review).
	const raw = pathArgument(input as Record<string, unknown> | undefined);
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	// pi's own resolution (`~`, `@`, `file://`, …): the guard must check the
	// file the tool will actually touch (lib/tool-path.ts).
	return resolveToolPath(raw, cwd);
}

/**
 * The files the context still shows after a compaction, as comparable paths:
 * the context stack (the CLAUDE.md family as claude-context discovers it, what
 * they `@`-import, and the auto-memory index), the plan file, and the files a
 * `read` in the kept turns returned. Claude Code's restore skips them; they
 * stay read.
 */
function inContextFiles(ctx: ExtensionContext, branch: readonly { type: string; customType?: string; data?: unknown }[], kept: string[]): Set<string> {
	const home = homedir();
	const stack = discoverContextFilePaths({ cwd: ctx.cwd, homeClaudeDir: claudeConfigDir(), agentsFallback: true }).map((file) => file.path);
	const imported = stack.flatMap((path) => {
		const content = readIfPresent(path);
		return content === undefined ? [] : [...collectImportedPaths(content, dirname(path), { home })];
	});
	return new Set(
		[...stack, ...imported, join(projectMemoryDir(ctx.cwd, home), "MEMORY.md"), planFileOnBranch(branch), ...kept.map((path) => resolveToolPath(path, ctx.cwd))]
			.filter((path): path is string => typeof path === "string")
			.map(comparablePath),
	);
}

/** Whether a read deny rule covers a file now; every file when the settings cannot be read (the gate reports them). */
function readDenied(ctx: ExtensionContext): (path: string) => boolean {
	try {
		const deny = parseRules(loadPermissionSettings(ctx.cwd, homedir()).deny);
		return (path) => deny.some((rule) => ruleMatches(rule, "read", path, ctx.cwd));
	} catch {
		return () => true;
	}
}

/** A file read again through pi's own read tool, as the model would see it; undefined when gone, unreadable or an image. */
async function readAgain(read: ReturnType<typeof createReadToolDefinition>, path: string, ctx: ExtensionContext): Promise<string | undefined> {
	try {
		const result = await read.execute("restore", { path }, undefined, undefined, ctx as never);
		if (result.content.some((block) => block.type !== "text")) return undefined;
		return result.content.map((block) => (block as { text: string }).text).join("\n");
	} catch {
		return undefined;
	}
}

export default function fileTrackerExtension(pi: ExtensionAPI) {
	let tracker = new FileTracker();
	let sessionId: string | undefined;
	/**
	 * Every file a read or write touched on this branch, with its modification
	 * time as stat'ed then (the transcript time for one replayed after a resume):
	 * the post-compaction restore's order.
	 */
	let touched = new Map<string, number>();
	/** Observe a file the model read or wrote, and record it as touched at its current modification time. */
	const touch = (path: string) => {
		const stamp = observeFromDisk(tracker, path);
		if (stamp) touched.set(path, stamp.mtimeMs);
	};

	// A resumed session (or a session_tree switch) carries reads the model did
	// earlier in the transcript; rebuild the tracker from the part of the branch
	// still in context (since the latest compaction's kept tail) so post-resume
	// edits are not refused as "never read" (replay.ts). A new session id starts
	// from an empty tracker.
	const reconstruct = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId?.() ?? undefined;
		if (id !== sessionId) {
			sessionId = id;
			tracker = new FileTracker();
		}
		let entries: unknown[] = [];
		try {
			entries = inContextEntries(ctx.sessionManager.getBranch() as unknown[]);
		} catch {
			return;
		}
		for (const raw of pathsReadOnBranch(entries)) {
			observeFromDisk(tracker, resolveToolPath(raw, ctx.cwd));
		}
		touched = new Map([...lastTouchesOnBranch(entries)].map(([raw, at]) => [resolveToolPath(raw, ctx.cwd), at]));
	};
	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

	pi.on("tool_call", (event, ctx) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		const path = pathOf(event.input, ctx.cwd);
		if (!path) return undefined;

		const current = readIfPresent(path);
		const status = tracker.status(path, current);

		// Creating a new file needs no prior read.
		if (status === "absent" || status === "fresh") return undefined;
		if (status === "unread") return { block: true, reason: UNREAD_REASON(path, event.toolName) };
		return { block: true, reason: STALE_REASON(path) };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return undefined;
		if (!READ_TOOLS.has(event.toolName) && !GUARDED_TOOLS.has(event.toolName)) return undefined;

		const path = pathOf(event.input, ctx.cwd);
		if (!path) return undefined;

		// After a read we know the file; after our own write we know it again, so a
		// successful edit does not make the file look stale to the next edit.
		touch(path);
		return undefined;
	});

	/**
	 * Claude Code's post-compaction file restore (`restore.ts`). The
	 * blocks open the next user message (`user-prepend`); an overflow compaction
	 * that retries the turn has no such message, so they ride the request's tail
	 * instead.
	 *
	 * Like Claude Code, the compaction also clears what the session has read:
	 * the summary no longer holds those files, so an edit needs a fresh read.
	 * A file the context still shows stays read (a kept turn's read, the
	 * context stack, the plan file), and a restored file counts as read and as
	 * touched for the next compaction's restore; a note never marks its file
	 * read.
	 */
	pi.on("session_compact", async (event: SessionCompactEvent, ctx) => {
		if (process.env.CC_COMPACTION === "0") return;
		const previous = tracker;
		const before = touched;
		tracker = new FileTracker();
		touched = new Map();
		try {
			const branch = ctx.sessionManager.getBranch();
			const compaction = latestCompaction(branch);
			const kept = compaction ? keptReadPaths(branch.slice(compaction.keptStart, compaction.index)) : [];
			const inContext = inContextFiles(ctx, branch, kept);
			for (const path of previous.tracked) if (inContext.has(comparablePath(path))) observeFromDisk(tracker, path);
			if (before.size === 0) return;
			const denied = readDenied(ctx);
			const candidates = restoreCandidates(before, (path) => inContext.has(comparablePath(path)) || denied(path));
			const read = createReadToolDefinition(ctx.cwd);
			const reads: RestoredRead[] = await Promise.all(candidates.map(async (path) => ({ path, text: await readAgain(read, path, ctx) })));
			const { blocks, restored } = restoreBlocks(reads, estimateTextTokens);
			const placement = event.willRetry ? "last-append" : "user-prepend";
			for (const text of blocks) pi.events.emit(REMINDER_CHANNEL, { text, placement } satisfies ReminderPayload);
			for (const path of restored) touch(path);
		} catch {
			// The restore is best effort: nothing comes back, and an edit needs a fresh read.
		}
	});

	/**
	 * Report anything that changed under us. Costs one stat per tracked file
	 * (only files the model actually touched) and a read only for a file whose
	 * stamp moved since we last read it; `alreadyNotified` keeps a repeat scan
	 * from repeating a warning.
	 *
	 * Two triggers:
	 * - `agent_start`, for changes made between turns. Not `before_agent_start`:
	 *   pi emits that only from `prompt()`, so a run opened by a harness
	 *   notification (a `/loop` tick, an agent report arriving while idle) never
	 *   fired it and changes went unreported until the next user prompt
	 *   (STEERING-REVIEW-2026-09-05 H1). `agent_start` fires for every run.
	 * - `tool_execution_end`, for changes made DURING a turn — a formatter hook,
	 *   a watcher, format-on-save in the user's editor, a `git checkout` by a
	 *   background command. Until 2026-09-05 these waited for the next prompt;
	 *   mid-turn the model discovered them only by hitting the stale-edit guard
	 *   (one blocked call plus a re-read per edit for anyone with an asynchronous
	 *   formatter). Claude Code computes its `edited_text_file` attachments on
	 *   every tool round, so the model reads the change before its next edit
	 *   (review M5). The one-shot is pending when the next request goes out and
	 *   the injector pins it to that tool result — pi runs `tool_result` hooks
	 *   BEFORE it emits `tool_execution_end` (agent-loop.js
	 *   finalizeExecutedToolCall → emitToolExecutionEnd), so it cannot be written
	 *   into the stored result; pinned is the same mechanism tool-search's
	 *   deferred-tool miss uses. Our own edit/write/read of a file was observed by
	 *   the `tool_result` handler above before this fires, so it is fresh here
	 *   and never reported as external — but only for a call that ran alone. pi
	 *   executes a batch of parallel tool calls CONCURRENTLY, so the first edit's
	 *   end fires while a sibling edit has already written its file and not yet
	 *   had its `tool_result` observation, and the scan reported the model's own
	 *   edit as "modified by the user, a linter, or a command"
	 *   (WEAK-MODEL-REVIEW-2026-09-06 M2). Hence `executing`: mid-turn the scan
	 *   runs only once the batch has fully drained.
	 */
	const reportExternalChanges = () => {
		const detailed: string[] = [];
		const overflow: string[] = [];
		for (const path of tracker.tracked) {
			// Undefined for a file tracked without content (oversized); an empty
			// file is compared like any other.
			const previous = tracker.lastSeen(path);
			if (previous === undefined) continue;
			const stamp = statIfPresent(path);
			if (stamp && tracker.unchangedOnDisk(path, stamp)) continue;
			const current = stamp ? readIfPresent(path) : undefined;
			if (stamp === undefined || current === undefined) {
				tracker.forget(path);
				detailed.push(`${path} no longer exists; it was deleted or moved after you read it.`);
				continue;
			}
			tracker.recordStamp(path, stamp);
			if (current === previous) continue;
			// Don't repeat the same warning every turn…
			if (tracker.alreadyNotified(path, current)) continue;

			if (detailed.length < DETAILED_CHANGE_REMINDERS_PER_TURN) {
				const excerpt = describeChanges(previous, current);
				if (excerpt) detailed.push(EXTERNAL_CHANGE_REMINDER(path, excerpt));
			} else {
				overflow.push(path);
			}
			// …but deliberately do NOT record the new content as seen: the file must
			// stay stale so the edit guard still forces a re-read. Marking it read
			// here would announce the change and then permit the clobbering edit.
			tracker.markNotified(path, current);
		}
		for (const text of detailed) pi.events.emit(REMINDER_CHANNEL, { text });
		if (overflow.length > 0) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `${overflow.length} more file(s) you read earlier changed on disk since: ${overflow.join(", ")}. Re-read any of them before editing it.`,
			});
		}
	};
	/**
	 * Tool calls currently executing, by call id. A batch issued in one assistant
	 * message runs concurrently, and only the last call to finish sees every
	 * sibling's write already observed.
	 */
	const executing = new Set<string>();
	pi.on("tool_execution_start", (event) => {
		executing.add(event.toolCallId);
		return undefined;
	});
	pi.on("agent_start", () => {
		// A turn aborted mid-batch can leave ids behind; each turn starts from a
		// clean set so the mid-turn scan cannot be wedged off for the rest of the
		// session.
		executing.clear();
		reportExternalChanges();
		return undefined;
	});
	pi.on("tool_execution_end", (event) => {
		executing.delete(event.toolCallId);
		if (executing.size > 0) return undefined;
		reportExternalChanges();
		return undefined;
	});
}
