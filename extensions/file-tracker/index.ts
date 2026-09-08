/**
 * file-tracker extension — Claude Code's read-before-write discipline.
 *
 * - `edit`/`write`/`notebook_edit` on a file that exists but was never read is
 *   blocked with an instruction to read it first.
 * - An edit to a file that changed since we last saw it is blocked, so the model
 *   cannot overwrite someone else's change.
 * - Files that change out of band are reported in a `<system-reminder>` with the
 *   new content around the change, line-numbered.
 *
 * Tracking is by content, not by tool call, which is what makes it catch writes
 * that went through bash and never touched an intercepted tool.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pathArgument } from "../auto-mode/paths.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { pathsReadOnBranch } from "./replay.ts";
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

/** Observe a file's current content together with the stamp it was read at. */
function observeFromDisk(tracker: FileTracker, path: string): void {
	const stamp = statIfPresent(path);
	const current = readIfPresent(path);
	if (current === undefined) tracker.forget(path);
	else tracker.observe(path, current, Date.now(), stamp);
}

function pathOf(input: unknown, cwd: string): string | undefined {
	// Share the field-name knowledge with the auto-mode gates: `path` for pi's
	// built-ins, `file_path`/`notebook_path` for Claude Code-shaped calls. A
	// notebook_edit using only `notebook_path` would otherwise bypass the
	// read-before-write guard (code-review).
	const raw = pathArgument(input as Record<string, unknown> | undefined);
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export default function fileTrackerExtension(pi: ExtensionAPI) {
	let tracker = new FileTracker();
	let sessionId: string | undefined;

	// A resumed session (or a session_tree switch) carries reads the model did
	// earlier in the transcript; rebuild the tracker from the branch so post-
	// resume edits are not refused as "never read" (replay.ts). A new session id
	// starts from an empty tracker.
	const reconstruct = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId?.() ?? undefined;
		if (id !== sessionId) {
			sessionId = id;
			tracker = new FileTracker();
		}
		let entries: unknown[] = [];
		try {
			entries = ctx.sessionManager.getBranch() as unknown[];
		} catch {
			return;
		}
		for (const raw of pathsReadOnBranch(entries)) {
			observeFromDisk(tracker, isAbsolute(raw) ? raw : resolve(ctx.cwd, raw));
		}
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
		observeFromDisk(tracker, path);
		return undefined;
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
			const previous = tracker.lastSeen(path);
			if (previous === undefined || previous === "") continue;
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
