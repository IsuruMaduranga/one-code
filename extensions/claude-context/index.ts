/**
 * claude-context extension — assembles Claude Code's three first-message context
 * reminders and queues them `first-prepend` (lib/claude-context.ts has the
 * formats): the instructions block (CLAUDE.md files + MEMORY.md index) at
 * CONTEXT_ORDER.claudeMd, the context block (userEmail + the git snapshot) at
 * CONTEXT_ORDER.context, and the date at CONTEXT_ORDER.date, which on a model
 * that takes a mid-conversation system message rides that message instead
 * (system-reminder, lib/system-role.ts). They are live state: a request that
 * opens an epoch renders them, and every later request in the epoch replays
 * them from the ledger's record (extensions/ledger). The blocks carry ledger
 * facts (lib/context-facts.ts), so the first request of a resumed process says
 * once what changed in the workspace since, and a session that crosses local
 * midnight learns the new date, both on the request's tail.
 *
 * When ONECODE.md files exist, this extension also emits a separate `# oneCodeMd`
 * block at CONTEXT_ORDER.oneCodeMd — after the instructions block, so One
 * Code-specific instructions take precedence over CLAUDE.md. Keeping them out
 * of that block leaves it byte-exact with Claude Code.
 *
 * Paths are re-derived from home/cwd here rather than shared with the memory
 * extension (jiti gives each extension its own module instance).
 */

import { brand, brandedId } from "../lib/brand.mjs";
import { feature } from "../lib/feature.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildClaudeMdBlock, buildContextBlock, buildOneCodeBlock, dateBlock, dateChangeReminder, localDate, nestedInstructionText } from "../lib/claude-context.ts";
import { collectImportedPaths, openInstructions } from "../lib/instructions.ts";
import { collectGitStatus, GIT_SNAPSHOT_OWNER_CHANNEL } from "../lib/git-status.ts";
import { readMemoryIndex } from "../lib/memory-index.ts";
import { productStateDir, tildify, tryRealpath } from "../lib/paths.ts";
import { fitToWindow, restoredInstructionNotice, type SkippedInstruction, skippedInstructionWarning } from "../lib/instruction-budget.ts";
import { queueNotice } from "../lib/notices.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest, toldBlockFact } from "../lib/reminders.ts";
import { inContextEntries } from "../lib/compaction-boundary.ts";
import { compactionGitStatus, contextBlockFacts, contextFingerprints, dateFingerprint, FACT_KEYS, instructionFacts, liveFingerprints, type LiveFingerprints, resumeFactsNotice } from "../lib/context-facts.ts";
import { resolveToolPath } from "../lib/tool-path.ts";
import { sessionWorkCwd, WORKTREE_CHANNEL, type WorktreeLocation } from "../lib/worktree-channel.ts";
import { pathArgument } from "../auto-mode/paths.ts";
import { HARNESS_GIT_CONFIG } from "../lib/git.ts";
import { EXTERNAL_INCLUDES_NO, EXTERNAL_INCLUDES_NONE, EXTERNAL_INCLUDES_SETTING, EXTERNAL_INCLUDES_YES, externalIncludesDialog, persistExternalIncludesApproval, readExternalIncludesApproval } from "../lib/claude-external-includes.ts";
import { registerLocalCommand } from "../lib/local-command.ts";
import { consentDialog, installConsentDialogs, startupConsentReady } from "../lib/consent-dialogs.ts";
import type { ToldFact } from "../lib/ledger/records.ts";
import { foldSession } from "../lib/ledger/fold-memo.ts";
import { sessionIdentity } from "../lib/anthropic-auth.ts";

const REMINDER_KEY = "claude-context";
const PRODUCT_REMINDER_KEY = `${brand.idPrefix}-context`;
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

/** A tool result and the nested instruction files it carried into context (`remember`). */
const NESTED_SHOWN_ENTRY = brandedId("nested-instructions-shown");

function claudeContextExtension(pi: ExtensionAPI) {
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
	/** The date the live date block carries. */
	let blockDate = "";
	/**
	 * Instruction files in context, by real path: the startup block's files and
	 * their imports (`startupShown`, fixed for the session), plus nested files
	 * attached, their imports, and files the model read itself.
	 */
	let startupShown = new Set<string>();
	let attachedNested = new Set<string>();
	/**
	 * Where a nested instruction actually landed (a persisted result or a pinned
	 * request tail), and the tokens of the instruction text it attached.
	 */
	const shownByResult = new Map<string, { keys: Set<string>; tokens: number }>();
	const remember = (toolCallId: string | undefined, keys: Iterable<string>, tokens = 0) => {
		if (!toolCallId) return;
		const shown = shownByResult.get(toolCallId) ?? { keys: new Set<string>(), tokens: 0 };
		const before = shown.keys.size;
		for (const key of keys) shown.keys.add(key);
		// Tokens come only with newly attached files, so no new key means nothing new to record.
		if (shown.keys.size === before) return;
		shown.tokens += tokens;
		shownByResult.set(toolCallId, shown);
		// Recorded on the branch, so a resume or a /tree switch knows what is already in context.
		pi.appendEntry(NESTED_SHOWN_ENTRY, { toolCallId, keys: [...shown.keys], tokens: shown.tokens });
	};
	/** The tokens the nested instruction text still in context takes: it shares the half with the loaded top-level files. */
	const nestedLoaded = () => {
		let total = 0;
		for (const shown of shownByResult.values()) total += shown.tokens;
		return total;
	};
	/** Rebuild what the branch's own results showed (a resume, a /tree switch), then keep what is still in context. */
	const restoreAttachments = (ctx: ExtensionContext) => {
		shownByResult.clear();
		for (const entry of ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]) {
			if (entry.type !== "custom" || entry.customType !== NESTED_SHOWN_ENTRY) continue;
			const data = entry.data as { toolCallId?: unknown; keys?: unknown; tokens?: unknown } | undefined;
			if (typeof data?.toolCallId !== "string" || !Array.isArray(data.keys)) continue;
			shownByResult.set(data.toolCallId, {
				keys: new Set(data.keys.filter((key): key is string => typeof key === "string")),
				tokens: typeof data.tokens === "number" ? data.tokens : 0,
			});
		}
		keepRetainedAttachments(ctx);
	};
	const keepRetainedAttachments = (ctx: ExtensionContext) => {
		attachedNested = new Set(startupShown);
		const kept = new Set(inContextEntries(ctx.sessionManager.getBranch()).flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
		));
		for (const [id, shown] of shownByResult) {
			if (kept.has(id)) for (const key of shown.keys) attachedNested.add(key);
			else shownByResult.delete(id);
		}
	};
	/** The entered worktree: reads there resolve below its root, not the session's original directory. */
	let entered: WorktreeLocation | undefined;
	pi.events.on(WORKTREE_CHANNEL, (data) => {
		const location = data as WorktreeLocation | null | undefined;
		entered = location?.path ? location : undefined;
	});
	let includeExternal = false;
	let approvalPending: Promise<void> | undefined;
	let approvalAbort = new AbortController();
	let sessionGeneration = 0;

	/**
	 * The instructions facts while no instructions block renders (no CLAUDE.md,
	 * no memory index): they ride the date block, so an epoch still tells the
	 * absence and a resume notices a file that appeared since.
	 */
	let absentInstructionFacts: ToldFact[] = [];
	const emitDate = (date: string) => {
		blockDate = date;
		pi.events.emit(REMINDER_CHANNEL, {
			text: dateBlock(date),
			key: DATE_REMINDER_KEY,
			placement: "first-prepend",
			order: CONTEXT_ORDER.date,
			facts: [toldBlockFact(FACT_KEYS.date, date), ...absentInstructionFacts],
		});
	};

	/**
	 * The live workspace's fingerprints, taken at this process's first turn, for
	 * the resumed-session check, in each directory the epoch's facts may have
	 * been read in: the session's own at its start, the entered worktree at a
	 * compaction (session_compact reads there).
	 */
	let livePrints: { atStart: LiveFingerprints; atCompaction: () => LiveFingerprints } | undefined;
	/** True until this process's first request inside an epoch has compared the epoch's facts with the live workspace. */
	let resumeCheck = true;
	/** The blocks' files, with the instruction view they were read under: it holds the settings (One Code's rule) for nested reads until the next refresh. */
	const readFiles = (cwd: string) => {
		const view = openInstructions(os.homedir(), getAgentDir());
		return { ...view.sections({ cwd, includeExternal }), memoryIndex: readMemoryIndex(cwd), view };
	};
	let files: ReturnType<typeof readFiles> | undefined;
	/**
	 * The files message 1 carries (or imports): never attached again on a read.
	 * Taken when an epoch renders the blocks; a resumed epoch's are taken from
	 * the live files at start, the closest knowledge this process has. A skipped
	 * file counts as shown (it is too large to attach), its imports do not.
	 */
	const adoptShown = (current: ReturnType<typeof readFiles>) => {
		const skippedPaths = new Set(live.map((file) => file.path));
		startupShown = new Set([...current.contextFiles, ...current.oneCodeFiles].flatMap((file) =>
			skippedPaths.has(file.path) ? [file.path] : [file.path, ...(file.imported ?? collectImportedPaths(readOrEmpty(file.path), dirname(file.path), { home: os.homedir() }))],
		).map((path) => tryRealpath(path) ?? path));
		for (const path of startupShown) attachedNested.add(path);
	};
	const snapshotGit = (cwd: string) => {
		const tools = pi.getActiveTools();
		const shellTool = tools.includes("powershell") && !tools.includes("bash") ? "powershell" : "bash";
		return takesGitSnapshot ? collectGitStatus(cwd, undefined, shellTool) : null;
	};

	const externalPaths = (cwd: string) => openInstructions(os.homedir(), getAgentDir()).externalIncludes({ cwd });
	const saveApproval = (ctx: ExtensionContext, approved: boolean) => {
		includeExternal = approved;
		try { persistExternalIncludesApproval(ctx.cwd, os.homedir(), approved); }
		catch (error) { ctx.ui.notify(`Could not remember external CLAUDE.md include approval: ${String(error)}`, "error"); }
	};
	/**
	 * The current model's context window: past half of it, the largest
	 * instruction files are skipped (lib/instruction-budget.ts). Every model switch opens an epoch, so the live
	 * blocks built with the new window are what the next request renders.
	 */
	let contextWindow: number | undefined;
	/** The instruction files fitted to the current window: both blocks' files in one budget. */
	const fitFiles = (current: ReturnType<typeof readFiles>) => {
		const fit = fitToWindow([...current.contextFiles, ...current.oneCodeFiles], contextWindow);
		const split = current.contextFiles.length;
		return { contextFiles: fit.files.slice(0, split), oneCodeFiles: fit.files.slice(split), skipped: fit.skipped, loaded: fit.loaded };
	};
	/** What a fit changes in the blocks' text: the skipped files and the sizes their notes state. */
	const skipKey = (skipped: readonly SkippedInstruction[]) => skipped.map((file) => `${file.path}\0${file.tokens}\0${file.contextWindow}`).join("\n");
	/** The files the live blocks skip, and the ones the user was last told of. */
	let live: SkippedInstruction[] = [];
	/** The tokens the live blocks' fitted instruction files take: a nested file gets what they and `nestedLoaded()` leave of the half. */
	let liveLoaded = 0;
	let toldPaths = new Set<string>();
	const warnSkipped = (ctx: ExtensionContext, file: SkippedInstruction) => {
		if (ctx.hasUI) queueNotice(pi.events, ctx, "warning", skippedInstructionWarning(tildify(file.path, os.homedir()), file));
	};
	/**
	 * Tell the user what changed in the live fit since they were last told: a
	 * newly skipped file, or one that loads again. Said at startup and before
	 * each prompt, so cycling models says it once.
	 */
	const announceFit = (ctx: ExtensionContext) => {
		const paths = new Set(live.map((file) => file.path));
		for (const file of live) if (!toldPaths.has(file.path)) warnSkipped(ctx, file);
		if (ctx.hasUI) {
			// Only a file still loaded is restored; a deleted one has nothing to say.
			const loaded = new Set([...(files?.contextFiles ?? []), ...(files?.oneCodeFiles ?? [])].map((file) => file.path));
			for (const path of toldPaths) if (!paths.has(path) && loaded.has(path)) queueNotice(pi.events, ctx, "info", restoredInstructionNotice(tildify(path, os.homedir()), contextWindow));
		}
		toldPaths = paths;
	};
	/**
	 * The instructions and ONECODE.md blocks as live state, read in `cwd`. They
	 * render when an epoch opens; inside one, message 1 is the record, so a
	 * change here (a /config approval, an edited file) shows at the next epoch.
	 * A file the window budget skips rides as a note naming its path; the facts
	 * still describe the files on disk.
	 */
	const emitInstructions = (current: ReturnType<typeof readFiles>, fit = fitFiles(current)) => {
		live = fit.skipped;
		liveLoaded = fit.loaded;
		const instructions = buildClaudeMdBlock({ contextFiles: fit.contextFiles, memoryIndex: current.memoryIndex });
		if (instructions) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: instructions,
				key: REMINDER_KEY,
				placement: "first-prepend",
				order: CONTEXT_ORDER.claudeMd,
				facts: instructionFacts(contextFingerprints(current)),
			});
		} else pi.events.emit(REMINDER_CHANNEL, { remove: true, key: REMINDER_KEY });
		const absent = instructions ? [] : instructionFacts(contextFingerprints(current));
		if (JSON.stringify(absent) !== JSON.stringify(absentInstructionFacts)) {
			absentInstructionFacts = absent;
			if (blockDate) emitDate(blockDate);
		}
		// One Code's own instructions ride in a separate block AFTER the instructions
		// block, so they take precedence over CLAUDE.md (higher order = closer to the user text).
		const oneCode = buildOneCodeBlock(fit.oneCodeFiles);
		if (oneCode) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: oneCode,
				key: PRODUCT_REMINDER_KEY,
				placement: "first-prepend",
				order: CONTEXT_ORDER.oneCodeMd,
			});
		} else pi.events.emit(REMINDER_CHANNEL, { remove: true, key: PRODUCT_REMINDER_KEY });
	};
	const emitContextBlock = (gitText: string | null, atCompaction: boolean) => {
		const context = buildContextBlock({ email, gitStatus: gitText });
		if (!context) {
			pi.events.emit(REMINDER_CHANNEL, { remove: true, key: CONTEXT_REMINDER_KEY });
			return;
		}
		pi.events.emit(REMINDER_CHANNEL, {
			text: context,
			key: CONTEXT_REMINDER_KEY,
			placement: "first-prepend",
			order: CONTEXT_ORDER.context,
			facts: contextBlockFacts(gitStatus ?? null, atCompaction),
		});
	};
	const refreshInstructions = (cwd: string) => {
		const current = readFiles(cwd);
		files = current;
		emitInstructions(current);
	};
	const askApproval = async (ctx: ExtensionContext, paths: string[], afterStartup = false) => {
		const gen = sessionGeneration;
		const signal = approvalAbort.signal;
		// No is first and focused, as in Claude Code. Escape is also a remembered no;
		// a shutdown/superseded session is not an answer at all.
		const choice = await consentDialog(pi.events, () => ctx.ui.select(externalIncludesDialog(paths, os.homedir()), [EXTERNAL_INCLUDES_NO, EXTERNAL_INCLUDES_YES], { signal }), afterStartup);
		if (signal.aborted || gen !== sessionGeneration) return;
		saveApproval(ctx, choice === EXTERNAL_INCLUDES_YES);
		refreshInstructions(ctx.cwd);
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
				const text = EXTERNAL_INCLUDES_NONE;
				ctx.ui.notify(text, "info");
				return text;
			}
			const row = `${EXTERNAL_INCLUDES_SETTING}: ${includeExternal ? "true" : "false"}`;
			const picked = await consentDialog(pi.events, () => ctx.ui.select("Config", [row], { signal: approvalAbort.signal }));
			if (picked !== row || gen !== sessionGeneration || approvalAbort.signal.aborted) return;
			if (includeExternal) {
				saveApproval(ctx, false);
				refreshInstructions(ctx.cwd);
			} else await askApproval(ctx, paths);
			// As in Claude Code, this changes future loads, never retracts text or
			// rewrites the frozen first-message block after a request was sent.
			return `${EXTERNAL_INCLUDES_SETTING}: ${includeExternal ? "true" : "false"}`;
		},
	});
	const drainApproval = async () => { startupConsentReady(pi.events); await approvalPending; };
	pi.on("before_agent_start", async (_event, ctx) => {
		const gen = sessionGeneration;
		await drainApproval();
		if (gen === sessionGeneration) announceFit(ctx);
	});
	pi.on("session_shutdown", () => {
		// A model_select before the next session_start must not rebuild this session's files.
		files = undefined;
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
		const approval = readExternalIncludesApproval(ctx.cwd, os.homedir());
		includeExternal = approval.approved;
		if ((event.reason ?? "startup") === "startup" && ctx.hasUI && !approval.approved && !approval.warningShown) {
			const paths = externalPaths(ctx.cwd);
			if (paths.length) {
				// RPC installs its input reader only AFTER session_start returns.
				// Queue after hooks/MCP consent; gate the first turn, not startup.
				// A dialog that fails is no answer: nothing is approved or remembered, and the turn goes on.
				approvalPending = askApproval(ctx, paths, true).catch(() => {});
			}
		}
		// The instructions block carries the instruction files lib/instructions.ts
		// and the profile's provider pick (One Code's: by default the CLAUDE.md
		// family, or the project's AGENTS.md files when it has no CLAUDE.md,
		// byte-exact with Claude Code either way). ONECODE.md rides its own
		// higher-precedence block.
		contextWindow = ctx.model?.contextWindow;
		refreshInstructions(ctx.cwd);
		toldPaths = new Set();
		announceFit(ctx);
		email = resolveEmail(ctx.cwd);
		attachedNested = new Set();
		if (files) adoptShown(files);
		restoreAttachments(ctx);
		// /clear and a resume re-fire session_start: this process takes its own snapshot.
		gitStatus = undefined;
		livePrints = undefined;
		resumeCheck = true;
		// The user's local date. Inside an epoch the block on message 1 is the
		// record, so a later date rides a notice (the render step below).
		emitDate(localDate());
	});

	// Claude Code snapshots git "at the start of the conversation": on the first
	// turn, typed or opened from idle, never in session_start, so the several
	// synchronous git spawns never delay the prompt opening (findings §15). The
	// clip note names the shell tool the model has (PowerShell only without bash).
	pi.on("turn_start", async (_event, ctx) => {
		const gen = sessionGeneration;
		await drainApproval();
		if (gen !== sessionGeneration || approvalAbort.signal.aborted) return;
		if (gitStatus !== undefined) return;
		// A process that starts on a compacted branch before the compaction's
		// epoch opened (/compact, then /reload) renders that epoch's message 1:
		// the blocks are the compaction's, not the conversation start's (R3-L11).
		// The fold is shared with tool-search and the ledger: one fold per branch state (lib/ledger/fold-memo.ts).
		const fold = foldSession(ctx.sessionManager, sessionIdentity(pi, ctx.model));
		if (fold.opensEpoch && fold.cause === "compaction") {
			refreshForCompaction(ctx);
			return;
		}
		gitStatus = snapshotGit(ctx.cwd);
		if (files) {
			const atStart = liveFingerprints(files, gitStatus, takesGitSnapshot);
			const workCwd = sessionWorkCwd(entered, ctx.cwd);
			// The entered worktree's, read only if the epoch's facts came from a compaction there.
			let inWorktree: LiveFingerprints | undefined;
			const atCompaction = () => (inWorktree ??= liveFingerprints(readFiles(workCwd), snapshotGit(workCwd), takesGitSnapshot));
			livePrints = { atStart, atCompaction: workCwd === ctx.cwd ? () => atStart : atCompaction };
		}
		emitContextBlock(gitStatus, false);
	});

	// Inside an epoch, two facts can have moved since its message 1: the date (a
	// session that crosses local midnight learns it, Claude Code's notice), and,
	// on the first request of a resumed process, the workspace the instructions
	// and git blocks describe. Each is said once, on the request's tail.
	pi.events.on(RENDER_CHANNEL, (data) => {
		const request = data as RenderRequest;
		if (request.epoch) {
			// This request renders the live blocks as message 1: with today's date,
			// even when it opens past local midnight (a model switch, a fold).
			resumeCheck = false;
			if (files) adoptShown(files);
			const today = localDate();
			if (blockDate && blockDate !== today) emitDate(today);
			return;
		}
		const today = localDate();
		const toldDate = request.toldBlocks.get(FACT_KEYS.date);
		if (blockDate && toldDate !== undefined && toldDate !== dateFingerprint(today)) {
			request.blocks.push({ text: dateChangeReminder(today), facts: [toldBlockFact(FACT_KEYS.date, today)] });
			// The live block too, so a later epoch (a model switch, a fold) renders today's date on message 1.
			emitDate(today);
		}
		if (!resumeCheck || !livePrints) return;
		const atCompaction = request.modes.get(FACT_KEYS.compaction) ?? false;
		const notice = resumeFactsNotice(request.toldBlocks, atCompaction, atCompaction ? livePrints.atCompaction() : livePrints.atStart);
		// Checked until a request shows the notice told (its facts are the live
		// fingerprints): a failed request revokes them, so the retry says it again.
		if (notice) request.blocks.push(notice);
		else resumeCheck = false;
	});

	// All successful compactions (manual, automatic and idle) fire this hook. The
	// summary opens an epoch, which renders these blocks: refresh them from the
	// workspace now, in the entered worktree if any.
	pi.on("session_compact", (_event, ctx) => refreshForCompaction(ctx));
	function refreshForCompaction(ctx: ExtensionContext) {
		const cwd = sessionWorkCwd(entered, ctx.cwd);
		refreshInstructions(cwd);
		// Only discarded carriers need reattachment; pi can retain the recent read/tool-result tail.
		keepRetainedAttachments(ctx);
		email = resolveEmail(cwd);
		gitStatus = snapshotGit(cwd);
		emitContextBlock(compactionGitStatus(gitStatus), true);
		emitDate(localDate());
	}

	// A model switch opens an epoch: rebuild the live blocks for its window when
	// the fit changes their text. The user hears of it before the next prompt.
	pi.on("model_select", (event) => {
		contextWindow = event.model?.contextWindow;
		if (!files) return;
		const fit = fitFiles(files);
		if (skipKey(fit.skipped) !== skipKey(live)) emitInstructions(files, fit);
	});

	// A branch switch leaves the attachments of the branch left behind; the new one may lack them.
	pi.on("session_tree", (_event, ctx) => {
		restoreAttachments(ctx);
	});

	// A successful read attaches nested instruction files and matching path rules
	// once each. These are one-shots: never replace the frozen first-prepend block.
	// lib/instructions.ts and the profile's provider own traversal, matching and source ordering.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const raw = pathArgument(event.input);
		if (!raw) return;
		const view = files?.view ?? openInstructions(os.homedir(), getAgentDir());
		const filePath = resolveToolPath(raw, ctx.cwd);
		// In a worktree, the directories between are below the worktree's root (its own root files
		// are the shared checkout's, which the startup block carries).
		const nested = view.nested({ filePath, cwd: sessionWorkCwd(entered, ctx.cwd), includeExternal });
		// A partial read is not evidence that the entire instruction file is shown.
		const input = event.input as { offset?: number; limit?: number };
		const truncated = (event.details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated;
		if ((input.offset ?? 1) <= 1 && input.limit == null && !truncated) {
			const readKey = tryRealpath(filePath) ?? filePath;
			attachedNested.add(readKey);
			remember(event.toolCallId, [readKey]);
		}
		// Bound to this read: system-reminder's hook for it has already run, so the
		// queue pins them to this result at the next request; unbound, the next result
		// in a parallel batch took them, beside another file (battery round 7).
		const shown: string[] = [];
		const before = liveLoaded + nestedLoaded();
		let used = before;
		for (const file of nested) {
			if (attachedNested.has(file.key)) continue;
			attachedNested.add(file.key);
			shown.push(file.key);
			// Past what the loaded top-level files and the nested ones in context (this
			// read's included) leave of the half, the note rides in its place
			// (lib/instruction-budget.ts), and its imports are not shown: a later read
			// may still attach one.
			const fit = fitToWindow([file], contextWindow, { used });
			used = fit.loaded;
			for (const over of fit.skipped) warnSkipped(ctx, over);
			if (fit.skipped.length === 0) {
				for (const imported of file.imported) {
					attachedNested.add(imported);
					shown.push(imported);
				}
			}
			pi.events.emit(REMINDER_CHANNEL, { text: nestedInstructionText(fit.files[0]), toolCallId: event.toolCallId });
		}
		// Recorded with the queued text: both are on the branch now (the text as a
		// pending one-shot bound to this result), so a quit before the request
		// keeps them in step, and an abandoned /tree branch takes both away.
		remember(event.toolCallId, shown, used - before);
	});
}

export default feature("claude-context", claudeContextExtension);
