/**
 * file-tracker extension — Claude Code's read-before-write discipline.
 *
 * - `edit`/`write`/`notebook_edit` on a file that exists but was never read is
 *   blocked with an instruction to read it first.
 * - An edit to a file that changed since we last saw it is blocked, so the model
 *   cannot overwrite someone else's change.
 * - Files that change out of band are reported in a `<system-reminder>` with the
 *   new content around the change, line-numbered.
 * - pi's read, write and edit results read as Claude Code's (`results.ts`).
 * - After a compaction, the files read or written most recently come back as
 *   Claude Code brings them back: the contents of a small one, a note to read
 *   a large one again (`restore.ts`), and the read state is cleared.
 *
 * Tracking is by content, not by tool call, which is what makes it catch writes
 * that went through bash and never touched an intercepted tool.
 */

import { CHILD_WROTE_CHANNEL, type ChildWrote } from "../lib/child-writes.ts";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionContext, type SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { pathArgument } from "../auto-mode/paths.ts";
import { bashParserReady } from "../lib/bash-parser.ts";
import { discoverContextFiles, instructionRule } from "../lib/claude-context.ts";
import { readExternalIncludesApproval } from "../lib/claude-external-includes.ts";
import { inContextEntries, latestCompaction } from "../lib/compaction-boundary.ts";
import { autoMemoryEnabled } from "../lib/auto-memory.ts";
import { projectMemoryDir } from "../lib/memory.ts";
import { claudeConfigDir, comparablePath, isPathAtOrUnder, tryRealpath } from "../lib/paths.ts";
import { estimateTextTokens } from "../lib/pi-ai-estimate.ts";
import { planFileOnBranch } from "../lib/plan-mode-channels.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "../lib/reminders.ts";
import { resolveToolPath } from "../lib/tool-path.ts";
import { parseRules, ruleMatches } from "../permissions/matcher.ts";
import { loadPermissionSettings } from "../permissions/settings.ts";
import { type FileObservation, filesSeenOnBranch, keptReadPaths, keptShellReadPaths, shellCallsOnBranch } from "./replay.ts";
import { type RestoredRead, restoreBlocks, restoreCandidates } from "./restore.ts";
import { fileToolResultContent } from "./results.ts";
import { shellReadPaths, shownInFull } from "./shell-reads.ts";
import { sessionWorkCwd, WORKTREE_CHANNEL, type WorktreeLocation } from "../lib/worktree-channel.ts";
import {
	describeChanges,
	CHILD_CHANGE_REMINDER, EXTERNAL_CHANGE_REMINDER,
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

/** Whether `path` is a regular file (symlinks followed): never a device, FIFO or directory. */
function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
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

function commandOf(input: unknown): string {
	const command = (input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : "";
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { type?: string; text?: string })?.type === "text" ? ((block as { text?: string }).text ?? "") : "").join("\n");
}

/**
 * A file's identity and version, from metadata only: `ctimeMs` changes on any
 * write, rename or metadata change, and cannot be set back by the writer.
 */
function versionOf(path: string): string | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The files a shell command may print, with each one's version as the command
 * starts (`shell-reads.ts` paths, resolved as the shell resolves them, from
 * the directory a literal `cd` earlier in the command moved to). Taken before
 * the command runs, so a file the command itself rewrites (`cat x; cp y x`)
 * is not certified with its new content (found by a GPT-6 Sol review,
 * 2026-10-04). Metadata only: this runs before the permission gate decides
 * the call, so a file the user then denies is never opened.
 */
function shellReadSnapshot(command: string, cwd: string): Map<string, string> {
	const snapshot = new Map<string, string>();
	if (!command) return snapshot;
	for (const path of shellReadPaths(command, cwd, homedir(), (dir) => readdirSync(dir))) {
		// Regular files only: a device or FIFO (`head -c 1 /dev/zero`) reports size 0
		// and a read of it never ends (found by a GPT-6 Astra review).
		if (!isRegularFile(path)) continue;
		const stamp = statIfPresent(path);
		if (!stamp || stamp.size > MAX_SHELL_READ_BYTES) continue;
		const version = versionOf(path);
		if (version !== undefined) snapshot.set(path, version);
	}
	return snapshot;
}

/**
 * Count as read each file the command printed in full and did not change:
 * its version before and after the command is the same, and the output holds
 * all of it. Observed, not touched: the post-compaction restore follows the
 * file tools, as Claude Code's does. Returns the files it observed.
 */
function observeShellReads(tracker: FileTracker, before: Map<string, string>, output: string): string[] {
	const observed: string[] = [];
	if (!output) return observed;
	for (const [path, version] of before) {
		const stamp = statIfPresent(path);
		if (!stamp || !isRegularFile(path) || versionOf(path) !== version) continue;
		const content = readIfPresent(path);
		if (content === undefined || versionOf(path) !== version) continue;
		if (!shownInFull(output, content)) continue;
		tracker.observe(path, content, Date.now(), stamp);
		observed.push(path);
	}
	return observed;
}

/** Above this a shell read's output is persisted, not shown, so the file cannot have been seen whole. */
const MAX_SHELL_READ_BYTES = 256 * 1024;

/**
 * Observe a file's current content together with the stamp it was read at.
 * Returns that stamp, and what was seen for the result that read it
 * (undefined when the file is gone).
 */
function observeFromDisk(tracker: FileTracker, path: string): { stamp?: FileStamp; seen?: FileObservation } {
	const stamp = statIfPresent(path);
	const current = readIfPresent(path);
	if (current === undefined) {
		tracker.forget(path);
		return stamp ? { stamp } : {};
	}
	tracker.observe(path, current, Date.now(), stamp);
	return stamp ? { stamp, seen: { path, size: stamp.size, mtimeMs: stamp.mtimeMs, sha256: sha256(current) } } : {};
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
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
 * they `@`-import, and the auto-memory index), the plan file, the files a
 * `read` in the kept turns returned (`kept`) and the files a kept bash call
 * showed in full (`keptShell`), both absolute as recorded. Claude Code's
 * restore skips them; they stay read.
 */
function inContextFiles(ctx: ExtensionContext, branch: readonly { type: string; customType?: string; data?: unknown }[], kept: string[], keptShell: string[]): Set<string> {
	const home = homedir();
	// Use the context loader's import confinement and approval: a literal
	// unapproved @import is not evidence that its file is still in context.
	const stack = discoverContextFiles({ cwd: ctx.cwd, home, homeClaudeDir: claudeConfigDir(), rule: instructionRule(home),
		includeExternal: readExternalIncludesApproval(ctx.cwd, home).approved,
	}).flatMap((file) => [file.path, ...(file.imported ?? [])]);
	return new Set(
		[...stack, autoMemoryEnabled(ctx.cwd) ? join(projectMemoryDir(ctx.cwd, home), "MEMORY.md") : undefined, planFileOnBranch(branch), ...kept, ...keptShell]
			.filter((path): path is string => typeof path === "string")
			.map(comparablePath),
	);
}

/**
 * Whether a file's contents may come back without the permission gate that a
 * `read` call passes: only a file that resolves (symlinks followed) inside the
 * working directory and that no read deny or ask rule covers now. Any other
 * file, one read outside the project after a question, say, is not restored;
 * the model reads it again through the gate if it needs it. Nothing passes
 * when the settings cannot be read (the gate reports them).
 */
function restoreAllowed(ctx: ExtensionContext): (path: string) => boolean {
	try {
		const settings = loadPermissionSettings(ctx.cwd, homedir());
		const rules = parseRules([...settings.deny, ...settings.ask]);
		const root = tryRealpath(ctx.cwd) ?? ctx.cwd;
		return (path) => {
			const real = tryRealpath(path);
			if (!real || !isPathAtOrUnder(real, root)) return false;
			return !rules.some((rule) => ruleMatches(rule, "read", path, ctx.cwd) || ruleMatches(rule, "read", real, ctx.cwd));
		};
	} catch {
		return () => false;
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
	/**
	 * The files each bash call showed in full, by call id, decided where the
	 * call ran: a compaction keeps the reads of the calls it keeps from this,
	 * since re-parsing a command later resolves it from today's directory.
	 */
	const shellReadsByCall = new Map<string, string[]>();
	const recordShellReads = (callId: string, paths: string[]) => {
		if (paths.length > 0) shellReadsByCall.set(callId, paths);
	};
	/** The entered worktree, where the shell runs while one is active (lib/worktree-channel.ts). */
	let entered: WorktreeLocation | undefined;
	pi.events.on(WORKTREE_CHANNEL, (data) => {
		const location = data as WorktreeLocation | null | undefined;
		entered = location?.path ? location : undefined;
	});
	let sessionId: string | undefined;
	/**
	 * Every file a read or write touched on this branch, with its modification
	 * time as stat'ed then (as the result recorded it, for one replayed after a
	 * resume): the post-compaction restore's order.
	 */
	let touched = new Map<string, number>();
	/**
	 * Files this session's own child agents changed since the parent last saw
	 * them (lib/child-writes.ts). Every way the parent sees a file clears its
	 * entry: a file tool, a shell read, a rebuild from disk, the change scan.
	 */
	const childWrites = new Map<string, string | undefined>();
	pi.events.on(CHILD_WROTE_CHANNEL, (data) => {
		const wrote = data as ChildWrote | undefined;
		if (wrote?.path) childWrites.set(wrote.path, wrote.agent);
	});
	/** Observe a file the model read or wrote, and record it as touched at its current modification time. */
	const touch = (path: string) => {
		childWrites.delete(path);
		const { stamp, seen } = observeFromDisk(tracker, path);
		if (stamp) touched.set(path, stamp.mtimeMs);
		return seen;
	};

	// A resumed session (or a /reload, a fork, a session_tree switch) carries
	// reads the model did earlier in the transcript; rebuild the tracker from
	// the part of the branch still in context (since the latest compaction's
	// kept tail) so later edits are not refused as "never read" (replay.ts).
	// Everything comes from the branch, as the results and pending entries
	// recorded it, never from this instance: pi runs the factory again on each
	// of those. A new session id starts from an empty tracker.
	const reconstruct = (ctx: ExtensionContext, fresh = false) => {
		const id = ctx.sessionManager.getSessionId?.() ?? undefined;
		if (fresh || id !== sessionId) {
			sessionId = id;
			tracker = new FileTracker();
		}
		// Tracked files are re-read from disk below: what a child wrote is now the baseline.
		childWrites.clear();
		let entries: unknown[] = [];
		try {
			entries = inContextEntries(ctx.sessionManager.getBranch() as unknown[]);
		} catch {
			return;
		}
		// What each result or restore saw, recorded at the time and by the path
		// the tool resolved: a file that changed since is stale, never taken as
		// read in its current form (round-2 review H1), and a gone one untracked.
		const files = filesSeenOnBranch(entries);
		const changed: Pick<FileObservation, "path" | "sha256">[] = [];
		for (const [path, { seen, notified }] of files) {
			const stamp = statIfPresent(path);
			const current = readIfPresent(path);
			if (current === undefined) continue;
			const hash = sha256(current);
			if (hash === seen.sha256) {
				tracker.observe(path, current, Date.now(), stamp);
				continue;
			}
			tracker.observeChanged(path, Date.now());
			// A version a notice already named is not announced again (round-3 review L9).
			if (!notified.has(hash)) changed.push({ path, sha256: hash });
		}
		if (changed.length > 0) {
			// Unkeyed: a key would let this notice replace an undelivered earlier one
			// whose versions the branch already counts as told.
			pi.events.emit(REMINDER_CHANNEL, {
				text: `These files changed on disk since you last read them in this conversation: ${changed.map((file) => file.path).join(", ")}. Read them again before editing them.`,
				notified: changed,
			} satisfies ReminderPayload);
		}
		// Shell reads need the bash grammar, which may still be loading this early.
		const target = tracker;
		shellReadsByCall.clear();
		const shellCalls = [...shellCallsOnBranch(entries)];
		if (shellCalls.length > 0) {
			void bashParserReady().then(() => {
				if (target !== tracker) return;
				// A replayed result has no before-state: the files as they are now stand in for it.
				for (const call of shellCalls) recordShellReads(call.id, observeShellReads(target, shellReadSnapshot(call.command, sessionWorkCwd(entered, ctx.cwd)), call.output));
			});
		}
		touched = new Map([...files].map(([path, { seen }]) => [path, seen.mtimeMs]));
	};
	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	// A branch switch keeps the session id, but the reads of the branch left
	// behind are not in context any more: start from an empty tracker, as for a
	// new session (found by an adversarial GPT-6 Astra run, 2026-10-04).
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx, true));

	/** Whether a write's file existed when the call was made, by call id: its result says "created" or "updated". */
	const writeTargetExisted = new Map<string, boolean>();

	/** Each running bash call's candidate files as they were when it started (`shellReadSnapshot`). */
	const shellSnapshots = new Map<string, Map<string, string>>();
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			await bashParserReady();
			// Relative paths in the command resolve where the shell runs: the entered worktree, if any.
			shellSnapshots.set(event.toolCallId, shellReadSnapshot(commandOf(event.input), sessionWorkCwd(entered, ctx.cwd)));
			return undefined;
		}
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		const path = pathOf(event.input, ctx.cwd);
		if (!path) return undefined;
		if (event.toolName === "write") writeTargetExisted.set(event.toolCallId, existsSync(path));

		const current = readIfPresent(path);
		const status = tracker.status(path, current);

		// Creating a new file needs no prior read.
		if (status === "absent" || status === "fresh") return undefined;
		if (status === "unread") return { block: true, reason: UNREAD_REASON(path, event.toolName) };
		return { block: true, reason: STALE_REASON(path) };
	});

	pi.on("tool_result", async (event, ctx) => {
		const existedBefore = writeTargetExisted.get(event.toolCallId);
		writeTargetExisted.delete(event.toolCallId);
		if (event.toolName === "bash") {
			const before = shellSnapshots.get(event.toolCallId);
			shellSnapshots.delete(event.toolCallId);
			if (before) {
				const observed = observeShellReads(tracker, before, textOf(event.content));
				recordShellReads(event.toolCallId, observed);
				for (const path of observed) childWrites.delete(path);
			}
			return undefined;
		}
		if (!READ_TOOLS.has(event.toolName) && !GUARDED_TOOLS.has(event.toolName)) return undefined;

		const path = pathOf(event.input, ctx.cwd);
		if (!path) return undefined;

		// After a read we know the file; after our own write we know it again, so a
		// successful edit does not make the file look stale to the next edit.
		// What the model saw, on the result: a resume compares it with the disk.
		const observation = event.isError ? undefined : touch(path);
		const content = fileToolResultContent({
			toolName: event.toolName,
			isError: event.isError,
			content: event.content,
			path,
			cwd: ctx.cwd,
			existedBefore,
			isEmptyFile: () => statIfPresent(path)?.size === 0,
		});
		if (!content && !observation) return undefined;
		return {
			...(content ? { content } : {}),
			...(observation ? { details: { ...((event.details as Record<string, unknown> | undefined) ?? {}), oneCodeFile: observation } } : {}),
		};
	});

	/**
	 * Claude Code's post-compaction file restore (`restore.ts`). The
	 * blocks open the next user message (`user-prepend`); a request that opens
	 * with none (the rest of a run after a mid-turn compaction, an overflow
	 * retry) carries them on its tail (`orTail`), so the model sees a restored
	 * file before it can edit it. A later compaction drops an undelivered one
	 * (`untilCompaction`): it restores for the epoch the one before it opened.
	 *
	 * Like Claude Code, the compaction also clears what the session has read:
	 * the summary no longer holds those files, so an edit needs a fresh read.
	 * A file the context still shows stays read (a kept turn's read or whole-file
	 * shell read, the context stack, the plan file), and a restored file counts
	 * as read and as touched for the next compaction's restore, here and after
	 * a reload or a resume (its block records what it showed); a note never
	 * marks its file read. Contents come back only for a file the gate would
	 * let through without a question (`restoreAllowed`).
	 */
	pi.on("session_compact", async (event: SessionCompactEvent, ctx) => {
		const before = touched;
		try {
			const branch = ctx.sessionManager.getBranch();
			const compaction = latestCompaction(branch);
			const keptTurns = compaction ? branch.slice(compaction.keptStart, compaction.index) : [];
			// The kept shell reads: what each kept bash call certified as it ran.
			const keptShell = keptShellReadPaths(keptTurns, (id) => shellReadsByCall.get(id), (path) => tracker.lastSeen(path));
			// A call the summary took never comes back: only the kept ones need their record.
			const keptCalls = new Set([...shellCallsOnBranch(keptTurns)].map((call) => call.id));
			for (const id of shellReadsByCall.keys()) if (!keptCalls.has(id)) shellReadsByCall.delete(id);
			const inContext = inContextFiles(ctx, branch, keptReadPaths(keptTurns), keptShell);
			// The loader lists imports by real path; a tracked path may be spelled through a symlink.
			const shown = (path: string) => inContext.has(comparablePath(path)) || inContext.has(comparablePath(tryRealpath(path) ?? path));
			// A file the context still shows keeps its read state (what the model
			// saw, not what is on disk now, so the stale-edit guard still holds)
			// and its touch time, for the next compaction's restore.
			for (const path of tracker.tracked) if (!shown(path)) tracker.forget(path);
			touched = new Map([...before].filter(([path]) => shown(path)));
			// Opting out of One Code's restore does not disable pi's compaction:
			// reads discarded by either summarizer still need a fresh read.
			if (process.env.CC_COMPACTION === "0" || before.size === 0) return;
			const allowed = restoreAllowed(ctx);
			const candidates = restoreCandidates(before, (path) => shown(path) || !allowed(path));
			const read = createReadToolDefinition(ctx.cwd);
			const reads: RestoredRead[] = await Promise.all(candidates.map(async (path) => ({ path, text: await readAgain(read, path, ctx) })));
			const shownText = new Map(reads.map(({ path, text }) => [path, text]));
			const { blocks, restored } = restoreBlocks(reads, estimateTextTokens);
			// The block that shows a file records what it showed, so a reload or a
			// resume counts the file read exactly where the branch holds the block
			// (replay.ts filesSeenOnBranch). The file counts as read only when the
			// disk now holds exactly what the block shows: one that changed while
			// it was read back (even back to where it started) fails safe, and a
			// fresh read is asked for instead of passing the stale-edit guard.
			const seen = new Map(
				restored.map((path) => {
					const observed = touch(path);
					const text = shownText.get(path);
					if (observed && (text === undefined || sha256(text) !== observed.sha256)) {
						tracker.forget(path);
						return [path, undefined] as const;
					}
					return [path, observed] as const;
				}),
			);
			for (const { text, restores } of blocks) {
				const observation = restores ? seen.get(restores) : undefined;
				pi.events.emit(REMINDER_CHANNEL, { text, placement: "user-prepend", orTail: true, untilCompaction: true, ...(observation ? { observations: [observation] } : {}) } satisfies ReminderPayload);
			}
		} catch {
			// The restore is best effort: nothing comes back, and an edit needs a fresh read.
			tracker = new FileTracker();
			touched = new Map();
			shellReadsByCall.clear();
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
	 *   (review M5). The one-shot is a pending entry when the next request goes
	 *   out, and the renderer places it on that request's trailing tool result
	 *   (lib/reminders.ts), the same mechanism tool-search's deferred-tool miss
	 *   uses; reminders never enter a stored result. Our own edit/write/read of a file was observed by
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
		// Each notice records the versions it names on its pending entry, so a
		// reload or a resume does not announce them again (replay.ts).
		const detailed: { text: string; notified?: Pick<FileObservation, "path" | "sha256"> }[] = [];
		const overflow: Pick<FileObservation, "path" | "sha256">[] = [];
		for (const path of tracker.tracked) {
			// Undefined for a file tracked without content (oversized); an empty
			// file is compared like any other.
			const previous = tracker.lastSeen(path);
			if (previous === undefined) continue;
			const stamp = statIfPresent(path);
			if (stamp && tracker.unchangedOnDisk(path, stamp)) continue;
			// This scan accounts for the child's write whatever it finds (same
			// content, already notified, overflow), so a later change by someone
			// else is never credited to that agent.
			const byChild = childWrites.has(path);
			const childAgent = childWrites.get(path);
			childWrites.delete(path);
			const current = stamp ? readIfPresent(path) : undefined;
			if (stamp === undefined || current === undefined) {
				tracker.forget(path);
				detailed.push({ text: `${path} no longer exists; it was deleted or moved after you last read or wrote it.` });
				continue;
			}
			tracker.recordStamp(path, stamp);
			if (current === previous) continue;
			// Don't repeat the same warning every turn…
			if (tracker.alreadyNotified(path, current)) continue;

			const version = { path, sha256: sha256(current) };
			if (detailed.length < DETAILED_CHANGE_REMINDERS_PER_TURN) {
				const excerpt = describeChanges(previous, current);
				if (excerpt) detailed.push({ text: byChild ? CHILD_CHANGE_REMINDER(path, childAgent, excerpt) : EXTERNAL_CHANGE_REMINDER(path, excerpt), notified: version });
			} else {
				overflow.push(version);
			}
			// …but deliberately do NOT record the new content as seen: the file must
			// stay stale so the edit guard still forces a re-read. Marking it read
			// here would announce the change and then permit the clobbering edit.
			tracker.markNotified(path, current);
		}
		for (const { text, notified } of detailed) pi.events.emit(REMINDER_CHANNEL, { text, ...(notified ? { notified: [notified] } : {}) } satisfies ReminderPayload);
		if (overflow.length > 0) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `${overflow.length} more file(s) you read earlier changed on disk since: ${overflow.map((file) => file.path).join(", ")}. Re-read any of them before editing it.`,
				notified: overflow,
			} satisfies ReminderPayload);
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
		// session. A write blocked before it ran left its existence entry behind,
		// and a blocked or aborted bash call its snapshot of file versions.
		executing.clear();
		writeTargetExisted.clear();
		shellSnapshots.clear();
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
