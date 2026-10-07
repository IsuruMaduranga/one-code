/**
 * claude-context extension — assembles Claude Code's three first-message context
 * reminders and queues them `first-prepend` (lib/claude-context.ts has the
 * formats): the instructions block (CLAUDE.md files + MEMORY.md index) at
 * CONTEXT_ORDER.claudeMd, the context block (userEmail + the git snapshot) at
 * CONTEXT_ORDER.context, and the date at CONTEXT_ORDER.date, which on a model
 * that takes a mid-conversation system message rides that message instead
 * (system-reminder, lib/system-role.ts). They ride the reminder queue
 * (per-request via pi's `context` event). system-reminder persists a hidden
 * snapshot so a resume retains the original facts without doubling the blocks.
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
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildClaudeMdBlock,
	buildContextBlock,
	buildOneCodeBlock,
	collectImportedPaths,
	dateBlock,
	dateChangeReminder,
	discoverContextFiles,
	discoverOneCodeFiles,
	externalInstructionIncludes,
	localDate,
	instructionRule,
	nestedInstructionFiles,
	nestedInstructionText,
} from "../lib/claude-context.ts";
import { collectGitStatus, GIT_SNAPSHOT_OWNER_CHANNEL } from "../lib/git-status.ts";
import { projectMemoryDir, truncateIndex } from "../lib/memory.ts";
import { claudeConfigDir, oneCodeStateDir, tryRealpath } from "../lib/paths.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, type ReminderEntry, tailAnchor } from "../lib/reminders.ts";
import { inContextEntries } from "../lib/compaction-boundary.ts";
import { CONTEXT_BASELINE_CHANNEL, CONTEXT_FACTS_REFRESH_CHANNEL, restoredContext, type ContextStackSnapshot } from "../lib/context-stack.ts";
import { compactionGitStatus, contextFactsBaseline, DATE_CHANGE_KEY, legacyResumeFactsNotice, RESUME_FACTS_KEY, resumeFactsNotice, storedFactsBaseline, type ContextFactsBaseline } from "../lib/context-facts.ts";
import { resolveToolPath } from "../lib/tool-path.ts";
import { sessionWorkCwd, WORKTREE_CHANNEL, type WorktreeLocation } from "../lib/worktree-channel.ts";
import { pathArgument } from "../auto-mode/paths.ts";
import { HARNESS_GIT_CONFIG } from "../lib/git.ts";
import { EXTERNAL_INCLUDES_NO, EXTERNAL_INCLUDES_SETTING, EXTERNAL_INCLUDES_YES, externalIncludesDialog, persistExternalIncludesApproval, readExternalIncludesApproval } from "../lib/claude-external-includes.ts";
import { registerLocalCommand } from "../lib/local-command.ts";
import { consentDialog, installConsentDialogs, startupConsentReady } from "../lib/consent-dialogs.ts";

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

function readOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
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
	const resetConsentDialogs = installConsentDialogs(pi.events);
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
	let hadInstructions = false;
	let hadOneCode = false;
	/**
	 * Instruction files in context, by real path: the startup block's files and
	 * their imports (`startupShown`, fixed for the session), plus nested files
	 * attached, their imports, and files the model read itself.
	 */
	let startupShown = new Set<string>();
	let attachedNested = new Set<string>();
	/** Where a nested instruction actually landed: a persisted result or a pinned request tail. */
	const shownByResult = new Map<string, Set<string>>();
	const pendingNested = new Set<string>();
	const remember = (toolCallId: string | undefined, keys: Iterable<string>) => {
		if (!toolCallId) return;
		const shown = shownByResult.get(toolCallId) ?? new Set<string>();
		for (const key of keys) shown.add(key);
		if (shown.size) shownByResult.set(toolCallId, shown);
	};
	const keepRetainedAttachments = (ctx: ExtensionContext) => {
		attachedNested = new Set(startupShown);
		const kept = new Set(inContextEntries(ctx.sessionManager.getBranch()).flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
		));
		for (const [id, keys] of shownByResult) {
			if (kept.has(id)) for (const key of keys) attachedNested.add(key);
			else shownByResult.delete(id);
		}
	};
	/** The entered worktree: reads there resolve below its root, not the session's original directory. */
	let entered: WorktreeLocation | undefined;
	pi.events.on(WORKTREE_CHANNEL, (data) => {
		const location = data as WorktreeLocation | null | undefined;
		entered = location?.path ? location : undefined;
	});
	/** The instruction rule, read with the startup block (it is settings, read once a session). */
	let rule: ReturnType<typeof instructionRule> | undefined;
	let includeExternal = false;
	let approvalPending: Promise<void> | undefined;
	let approvalAbort = new AbortController();
	let sessionGeneration = 0;
	let requestStarted = false;

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

	let facts: ContextFactsBaseline | undefined;
	let pendingResume: ContextStackSnapshot | undefined;
	const baseline = () => ({ startupShown: [...startupShown], shownDate, facts });
	const publishBaseline = () => pi.events.emit(CONTEXT_BASELINE_CHANNEL, { key: "claude-context", value: baseline() });
	const readFiles = (cwd: string) => {
		const oneCodeFiles = discoverOneCodeFiles({ cwd, homeOneCodeDir: oneCodeStateDir(), home: os.homedir(), includeExternal });
		return {
			contextFiles: discoverContextFiles({ cwd, homeClaudeDir: claudeConfigDir(), rule: instructionRule(os.homedir()), home: os.homedir(), includeExternal }),
			memoryIndex: readMemoryIndex(cwd),
			oneCodeFiles,
			oneCode: buildOneCodeBlock(oneCodeFiles),
		};
	};
	let files: ReturnType<typeof readFiles> | undefined;
	const adoptFiles = (current: ReturnType<typeof readFiles>) => {
		files = current;
		// A file either startup block carries (or imports) is never attached again on a read.
		startupShown = new Set([...current.contextFiles, ...current.oneCodeFiles].flatMap((file) =>
			[file.path, ...(file.imported ?? collectImportedPaths(readOrEmpty(file.path), dirname(file.path), { home: os.homedir() }))],
		).map((path) => tryRealpath(path) ?? path));
		attachedNested = new Set(startupShown);
		rule = instructionRule(os.homedir());
	};
	const snapshotGit = (cwd: string) => {
		const tools = pi.getActiveTools();
		const shellTool = tools.includes("powershell") && !tools.includes("bash") ? "powershell" : "bash";
		return takesGitSnapshot ? collectGitStatus(cwd, undefined, shellTool) : null;
	};

	const externalPaths = (cwd: string) => externalInstructionIncludes({ cwd, homeClaudeDir: claudeConfigDir(), rule: instructionRule(os.homedir()), home: os.homedir() });
	const saveApproval = (ctx: ExtensionContext, approved: boolean) => {
		includeExternal = approved;
		try { persistExternalIncludesApproval(ctx.cwd, os.homedir(), approved); }
		catch (error) { ctx.ui.notify(`Could not remember external CLAUDE.md include approval: ${String(error)}`, "error"); }
	};
	const refreshUnsentInstructions = (cwd: string) => {
		if (requestStarted || pendingResume) return;
		const current = readFiles(cwd);
		adoptFiles(current);
		const text = buildClaudeMdBlock(current);
		if (text) pi.events.emit(REMINDER_CHANNEL, { text, scope: "every-turn", key: REMINDER_KEY, placement: "first-prepend", order: CONTEXT_ORDER.claudeMd });
		if (current.oneCode) pi.events.emit(REMINDER_CHANNEL, { text: current.oneCode, scope: "every-turn", key: ONECODE_REMINDER_KEY, placement: "first-prepend", order: CONTEXT_ORDER.oneCodeMd });
		publishBaseline();
	};
	const askApproval = async (ctx: ExtensionContext, paths: string[], afterStartup = false) => {
		const gen = sessionGeneration;
		const signal = approvalAbort.signal;
		// No is first and focused, as in Claude Code. Escape is also a remembered no;
		// a shutdown/superseded session is not an answer at all.
		const choice = await consentDialog(pi.events, () => ctx.ui.select(externalIncludesDialog(paths, os.homedir()), [EXTERNAL_INCLUDES_NO, EXTERNAL_INCLUDES_YES], { signal }), afterStartup);
		if (signal.aborted || gen !== sessionGeneration) return;
		saveApproval(ctx, choice === EXTERNAL_INCLUDES_YES);
		refreshUnsentInstructions(ctx.cwd);
	};
	registerLocalCommand(pi, "config", {
		description: "Configure external CLAUDE.md includes for this project",
		reportsResult: true,
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const text = "/config requires an interactive UI to change external CLAUDE.md include approval.";
				process.stderr.write(`${text}\n`);
				return text;
			}
			const gen = sessionGeneration;
			startupConsentReady(pi.events);
			await approvalPending;
			if (gen !== sessionGeneration || approvalAbort.signal.aborted) return;
			const paths = externalPaths(ctx.cwd);
			if (!paths.length) {
				const text = "No external CLAUDE.md includes found.";
				ctx.ui.notify(text, "info");
				return text;
			}
			const row = `${EXTERNAL_INCLUDES_SETTING}: ${includeExternal ? "true" : "false"}`;
			const picked = await consentDialog(pi.events, () => ctx.ui.select("Config", [row], { signal: approvalAbort.signal }));
			if (picked !== row || gen !== sessionGeneration || approvalAbort.signal.aborted) return;
			if (includeExternal) {
				saveApproval(ctx, false);
				refreshUnsentInstructions(ctx.cwd);
			} else await askApproval(ctx, paths);
			// As in Claude Code, this changes future loads, never retracts text or
			// rewrites the frozen first-message block after a request was sent.
			return `${EXTERNAL_INCLUDES_SETTING}: ${includeExternal ? "true" : "false"}`;
		},
	});
	const drainApproval = async () => { startupConsentReady(pi.events); await approvalPending; };
	pi.on("before_agent_start", drainApproval);
	pi.on("session_shutdown", () => {
		resetConsentDialogs();
		++sessionGeneration;
		approvalAbort.abort();
		approvalPending = undefined;
	});

	pi.on("session_start", (event, ctx) => {
		resetConsentDialogs();
		++sessionGeneration;
		approvalAbort.abort();
		approvalAbort = new AbortController();
		approvalPending = undefined;
		requestStarted = false;
		const approval = readExternalIncludesApproval(ctx.cwd, os.homedir());
		includeExternal = approval.approved;
		const restored = restoredContext(pi.events);
		pendingResume = restored;
		files = undefined;
		facts = undefined;
		if ((event.reason ?? "startup") === "startup" && ctx.hasUI && !approval.approved && !approval.warningShown) {
			const paths = externalPaths(ctx.cwd);
			if (paths.length) {
				// RPC installs its input reader only AFTER session_start returns.
				// Queue after hooks/MCP consent; gate the first turn, not startup.
				approvalPending = askApproval(ctx, paths, true);
				approvalPending.catch(() => {});
			}
		}
		if (restored) {
			const baseline = restored.baselines["claude-context"] as { startupShown?: unknown; shownDate?: unknown; facts?: unknown } | undefined;
			facts = storedFactsBaseline(baseline?.facts);
			startupShown = new Set(Array.isArray(baseline?.startupShown) ? baseline.startupShown.filter((p): p is string => typeof p === "string") : []);
			attachedNested = new Set(startupShown);
			rule = instructionRule(os.homedir());
			gitStatus = null; // The stored snapshot wins; do not take another one.
			blockDate = restored.stack.find((entry) => entry.key === DATE_REMINDER_KEY)?.text.match(/^Today's date is (\d{4}-\d{2}-\d{2})\.$/)?.[1] ?? "";
			shownDate = typeof baseline?.shownDate === "string" ? baseline.shownDate : blockDate;
			publishBaseline();
			return;
		}
		// The instructions block carries the instruction files the mode and Claude
		// Code's instructionFiles pick (lib/claude-context.ts instructionRule): by
		// default the CLAUDE.md family, or the project's AGENTS.md files when it
		// has no CLAUDE.md, byte-exact with Claude Code either way. ONECODE.md
		// rides its own higher-precedence block below.
		const current = readFiles(ctx.cwd);
		adoptFiles(current);
		const instructions = buildClaudeMdBlock(current);
		if (instructions) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: instructions,
				scope: "every-turn",
				key: REMINDER_KEY,
				placement: "first-prepend",
				order: CONTEXT_ORDER.claudeMd,
			});
		} else if (hadInstructions) {
			pi.events.emit(REMINDER_CHANNEL, { remove: true, key: REMINDER_KEY });
		}
		hadInstructions = instructions !== null;
		email = resolveEmail(ctx.cwd);
		attachedNested = new Set(startupShown);
		shownByResult.clear();
		pendingNested.clear();
		rule = instructionRule(os.homedir());
		// /clear re-fires session_start: the next conversation takes its own snapshot.
		gitStatus = undefined;
		// The user's local date, taken once: the reminder is frozen after the first
		// request, so a later date rides a one-shot (before_agent_start below).
		emitDate(localDate());

		// One Code's own instructions ride in a separate block AFTER the instructions
		// block, so they take precedence over CLAUDE.md (higher order = closer to the user text).
		const oneCode = current.oneCode;
		if (oneCode) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: oneCode,
				scope: "every-turn",
				key: ONECODE_REMINDER_KEY,
				placement: "first-prepend",
				order: CONTEXT_ORDER.oneCodeMd,
			});
		} else if (hadOneCode) {
			pi.events.emit(REMINDER_CHANNEL, { remove: true, key: ONECODE_REMINDER_KEY });
		}
		publishBaseline();
		hadOneCode = oneCode !== null;
	});

	// Claude Code snapshots git "at the start of the conversation": on the first
	// turn, typed or opened from idle, never in session_start, so the several
	// synchronous git spawns never delay the prompt opening (findings §15). The
	// clip note names the shell tool the model has (PowerShell only without bash).
	pi.on("turn_start", async (_event, ctx) => {
		const gen = sessionGeneration;
		await drainApproval();
		if (gen !== sessionGeneration || approvalAbort.signal.aborted) return;
		requestStarted = true;
		// Check only once, just before the first resumed request. No startup git
		// subprocesses, and no changes to the historical first-message blocks.
		if (pendingResume) {
			const restored = pendingResume;
			pendingResume = undefined;
			const cwd = sessionWorkCwd(entered, ctx.cwd);
			const current = readFiles(cwd);
			const liveGit = snapshotGit(cwd);
			const liveFacts = contextFactsBaseline({ ...current, gitStatus: liveGit, atCompaction: false });
			const text = facts ? resumeFactsNotice(facts, liveFacts) : legacyResumeFactsNotice(restored.stack, {
				instructions: buildClaudeMdBlock(current), email: resolveEmail(cwd), gitStatus: liveGit,
			});
			if (text) pi.events.emit(REMINDER_CHANNEL, { key: RESUME_FACTS_KEY, text });
		}
		if (gitStatus !== undefined) return;
		gitStatus = snapshotGit(ctx.cwd);
		if (files) facts = contextFactsBaseline({ ...files, gitStatus, atCompaction: false });
		publishBaseline();
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
	const announceDate = () => {
		if (!blockDate) return;
		const today = localDate();
		if (today === shownDate) return;
		shownDate = today;
		pi.events.emit(REMINDER_CHANNEL, { key: DATE_CHANGE_KEY, text: dateChangeReminder(today) });
		publishBaseline();
	};
	pi.on("before_agent_start", announceDate);

	// All successful compactions (manual, automatic and idle) fire this hook.
	// The summary starts a new prefix: refresh facts silently, then persist the
	// replacement even if the process exits before another model request.
	pi.on("session_compact", (_event, ctx) => {
		pendingResume = undefined;
		const cwd = sessionWorkCwd(entered, ctx.cwd);
		const current = readFiles(cwd);
		adoptFiles(current);
		// Only discarded carriers need reattachment; pi can retain the recent read/tool-result tail.
		keepRetainedAttachments(ctx);
		email = resolveEmail(cwd);
		gitStatus = snapshotGit(cwd);
		blockDate = shownDate = localDate();
		facts = contextFactsBaseline({ ...current, gitStatus, atCompaction: true });
		const entries: ReminderEntry[] = [];
		const add = (key: string, text: string | null, order: number) => {
			if (text) entries.push({ key, text, order, placement: "first-prepend" });
		};
		add(REMINDER_KEY, buildClaudeMdBlock(current), CONTEXT_ORDER.claudeMd);
		add(ONECODE_REMINDER_KEY, current.oneCode, CONTEXT_ORDER.oneCodeMd);
		add(CONTEXT_REMINDER_KEY, buildContextBlock({ email, gitStatus: compactionGitStatus(gitStatus) }), CONTEXT_ORDER.context);
		add(DATE_REMINDER_KEY, dateBlock(blockDate), CONTEXT_ORDER.date);
		pi.events.emit(CONTEXT_FACTS_REFRESH_CHANNEL, { entries, baseline: baseline() });
	});

	// A branch switch leaves the attachments of the branch left behind; the new one may lack them.
	pi.on("session_tree", () => {
		attachedNested = new Set(startupShown);
		shownByResult.clear();
		pendingNested.clear();
	});

	// system-reminder runs first: any still-pending one-shots have just been pinned to this tail.
	pi.on("context", (event) => {
		const anchor = tailAnchor(event.messages);
		if (anchor?.kind === "toolResult") remember(anchor.toolCallId, pendingNested);
		pendingNested.clear();
	});

	// A successful read attaches nested instruction files and matching path rules
	// once each. These are one-shots: never replace the frozen first-prepend block.
	// lib/claude-context.ts owns traversal, matching and source ordering.
	pi.on("tool_result", (event, ctx) => {
		// A queued attachment from an earlier result was persisted into this one
		// by system-reminder's earlier hook, even if this is not itself a read.
		remember(event.toolCallId, pendingNested);
		pendingNested.clear();
		if (event.toolName !== "read" || event.isError) return;
		const raw = pathArgument(event.input);
		if (!raw) return;
		rule ??= instructionRule(os.homedir());
		const filePath = resolveToolPath(raw, ctx.cwd);
		// In a worktree, the directories between are below the worktree's root (its own root files
		// are the shared checkout's, which the startup block carries).
		const files = nestedInstructionFiles({ filePath, cwd: sessionWorkCwd(entered, ctx.cwd), rule, home: os.homedir(), includeExternal });
		// A partial read is not evidence that the entire instruction file is shown.
		const input = event.input as { offset?: number; limit?: number };
		const truncated = (event.details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated;
		if ((input.offset ?? 1) <= 1 && input.limit == null && !truncated) {
			const readKey = tryRealpath(filePath) ?? filePath;
			attachedNested.add(readKey);
			remember(event.toolCallId, [readKey]);
		}
		for (const file of files) {
			if (attachedNested.has(file.key)) continue;
			attachedNested.add(file.key);
			pendingNested.add(file.key);
			for (const imported of file.imported) {
				attachedNested.add(imported);
				pendingNested.add(imported);
			}
			pi.events.emit(REMINDER_CHANNEL, { text: nestedInstructionText(file) });
		}
	});
}
