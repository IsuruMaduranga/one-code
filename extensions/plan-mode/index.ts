/**
 * plan-mode extension — Claude Code's EnterPlanMode / ExitPlanMode tools,
 * file-based: the plan lives at ~/.onecode/plans/<slug>.md, the one path plan
 * mode may write. The path is announced to the model in an every-turn reminder
 * and to the permissions extension over the event bus, and exit_plan_mode
 * reads the file rather than taking the plan as a parameter.
 *
 * Mode state is owned by the permissions extension; this extension requests
 * changes over MODE_CHANNEL and reacts to transitions it observes on
 * PERMISSION_STATUS_CHANNEL (which fires on every setMode). The plan block is
 * (re)installed at two points: synchronously on the transition INTO plan mode
 * (the status handler, with the last context seen), so a ctrl+q during a long
 * turn puts the block on the queue before the turn's next request — until
 * 2026-09-05 the mid-turn requests ran with no plan reminder while every edit
 * was denied "see the plan-mode reminder" (STEERING-REVIEW-2026-09-05 M3) —
 * and on session_start, after restoring a previous path and its baseline.
 * A session that STARTS in plan mode must install the block before the first
 * prompt is stamped: before_agent_start is already too late to anchor it to
 * that prompt. before_agent_start also re-announces the existing state.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFormTool } from "../lib/tool-variants.ts";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { oneCodeStateDir } from "../lib/paths.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { canShowCustomUi } from "../lib/headless-output.ts";
import { ccToolRenderers, safeThemePaint } from "../lib/tui-render.ts";
import { userDenialText } from "../lib/user-denial.ts";
import type { PermissionMode } from "../permissions/matcher.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../permissions/modes.ts";
import { buildPlanModeReminder } from "./reminder.ts";
import { randomSlug } from "./slug.ts";
import { readState, recordState } from "../lib/ledger/state.ts";

/** A plan file larger than this is named after a compaction, not inlined: the model reads it when it needs it. */
const PLAN_REFERENCE_CHARS = 40_000;

/** Claude Code's plan_file_reference attachment (utils/messages.ts), the plan the summary replaced. */
function planFileReferenceText(path: string, content: string): string {
	if (content.length > PLAN_REFERENCE_CHARS) return `A plan file exists from plan mode at: ${path}\n\nIt is too large to include here (${content.length.toLocaleString("en-US")} characters); read it before continuing.\n\nIf this plan is relevant to the current work and not already complete, continue working on it.`;
	return `A plan file exists from plan mode at: ${path}\n\nPlan contents:\n\n${content}\n\nIf this plan is relevant to the current work and not already complete, continue working on it.`;
}

/** The branch's record of whether the plan file existed when the current plan-mode run began. */
const PLAN_ENTRY_STATE = "plan-mode:entry";
import {
	approvedPlanText,
	ENTER_PLAN_MODE_DESCRIPTION,
	enteredPlanModeText,
	enterPlanModeDescription,
	EXIT_PLAN_MODE_DESCRIPTION,
	exitedPlanModeText,
} from "./texts.ts";
import { createMarkdownProse } from "../subagents/prose.ts";
import type { ProseRenderer } from "../subagents/panel-render.ts";
import {
	clampOffset,
	decodeViewerKey,
	initialPlanChoice,
	KEEP_PLANNING_QUESTION,
	type PlanChoice,
	planLines,
	renderPlanViewer,
	runPlanApproval,
	selectPlanChoice,
} from "./viewer.ts";

import { MODE_CHANNEL, PLAN_FILE_CHANNEL, PLAN_FILE_ENTRY, planFileOnBranch } from "../lib/plan-mode-channels.ts";
import { panelUi } from "../lib/panel-focus.ts";
export { MODE_CHANNEL, PLAN_FILE_CHANNEL };

const PLANS_DIR = () => join(oneCodeStateDir(), "plans");

/** How each mode is named in the approval choices. */
const MODE_NAMES: Record<PermissionMode, string> = {
	default: "manual approvals",
	acceptEdits: "auto-accept edits",
	plan: "plan mode",
	auto: "auto mode",
	bypassPermissions: "bypass permissions",
	dontAsk: "dontAsk",
};

export default function planModeExtension(pi: ExtensionAPI) {
	/** The last mode broadcast by permissions; undefined until the first status arrives. */
	let currentMode: string | undefined;
	/**
	 * The live mode the last switch into plan mode came from. It is recorded on
	 * the branch only when that switch begins a run (`refresh` finds no run
	 * recorded for the branch's plan file). A switch that merely restores a run,
	 * permissions following a /tree to a branch in plan mode, keeps the branch's
	 * own value, since the live mode before it belongs to the abandoned branch.
	 */
	let enteredFrom: PermissionMode | undefined;

	/**
	 * The current run as the branch recorded it when plan mode came on: its plan
	 * file, whether that file existed then (which picks Claude Code's "Plan File
	 * Info" line, fixed for the run so the sticky block stays byte-identical turn
	 * after turn, plan-mode/reminder.ts), and the mode it came from, offered
	 * first on exit (Claude Code's ExitPlanMode restores `prePlanMode`). Read
	 * from the branch every time, never kept here, so a /reload, a resume and a
	 * /tree each see the run of the branch they land on. Until 2026-09-05 the
	 * exit could only escalate: a default-mode session that planned was offered
	 * auto (PERMISSIONS-REVIEW-2026-09-05 M4).
	 */
	const runOnBranch = (ctx: ExtensionContext, path: string): { existed: boolean; modeBeforePlan?: PermissionMode } | undefined => {
		const stored = readState(ctx, PLAN_ENTRY_STATE) as { path?: unknown; existed?: unknown; modeBeforePlan?: unknown } | undefined;
		if (stored?.path !== path || typeof stored.existed !== "boolean") return undefined;
		const before = typeof stored.modeBeforePlan === "string" && stored.modeBeforePlan in MODE_NAMES && stored.modeBeforePlan !== "plan" ? (stored.modeBeforePlan as PermissionMode) : undefined;
		return { existed: stored.existed, ...(before ? { modeBeforePlan: before } : {}) };
	};

	/**
	 * The branch's plan file, else a fresh slug recorded on the branch. Never
	 * cached: on /tree, permissions' session_tree switches the mode (and this
	 * extension refreshes) before this extension's own session_tree runs, so a
	 * cached path would be the abandoned branch's.
	 */
	const ensurePlanFile = (ctx: ExtensionContext): string => {
		const onBranch = planFileOnBranch(ctx.sessionManager.getBranch());
		if (onBranch) return onBranch;

		let path = join(PLANS_DIR(), `${randomSlug()}.md`);
		for (let attempt = 0; attempt < 5 && existsSync(path); attempt++) {
			path = join(PLANS_DIR(), `${randomSlug()}.md`);
		}
		pi.appendEntry(PLAN_FILE_ENTRY, { path });
		return path;
	};

	/** Re-announce path + reminder; a re-emit replaces the sticky state by key. */
	const refresh = (ctx: ExtensionContext, toolCallId?: string) => {
		const path = ensurePlanFile(ctx);
		let run = runOnBranch(ctx, path);
		if (!run) {
			// A run begins: record what it began with.
			run = { existed: existsSync(path), ...(enteredFrom ? { modeBeforePlan: enteredFrom } : {}) };
			recordState(pi, PLAN_ENTRY_STATE, { path, ...run });
		}
		pi.events.emit(PLAN_FILE_CHANNEL, { path });
		pi.events.emit(REMINDER_CHANNEL, {
			text: buildPlanModeReminder(path, run.existed),
			key: "permission-mode",
			placement: "sticky-append",
			toolCallId,
		});
	};

	/**
	 * pi-tui's Markdown renderer for the approval dialog, loaded on first use.
	 * A failed load is not cached (the theme may not be ready yet); the dialog
	 * then wraps the plan as plain text.
	 */
	let markdownLoad: Promise<ProseRenderer | undefined> | undefined;
	const planMarkdown = (): Promise<ProseRenderer | undefined> =>
		(markdownLoad ??= createMarkdownProse().catch(() => {
			markdownLoad = undefined;
			return undefined;
		}));

	/** Plan approvals the user dismissed without words: the turn stops once pi records their result. */
	const abortAfterResult = new Set<string>();
	pi.on("tool_execution_end", (event, ctx) => {
		if (abortAfterResult.delete(event.toolCallId)) ctx.abort();
	});

	/** The last context seen, for a refresh triggered off the bus (no ctx of its own). */
	let lastCtx: ExtensionContext | undefined;

	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		const status = data as PermissionStatus;
		if (typeof status?.mode !== "string") return;
		const previous = currentMode;
		currentMode = status.mode;
		// Unknown for a session that STARTED in plan mode (the first status seen
		// is plan itself): a run it begins offers the fixed list on exit.
		if (currentMode === "plan" && previous !== "plan") enteredFrom = previous as PermissionMode | undefined;
		// The run ended: the next entry decides afresh.
		if (previous === "plan" && currentMode !== "plan") recordState(pi, PLAN_ENTRY_STATE, null);
		// Entering plan mode mid-turn: permissions' setMode has just closed the
		// shared "permission-mode" key (before broadcasting this status, so this
		// re-add is not undone) and will announce the change on the next tool
		// result; the standing block has to be back on the queue for that same
		// request. The path is announced over PLAN_FILE_CHANNEL inside refresh,
		// synchronously, so setMode's announcement can name it.
		if (currentMode === "plan" && previous !== "plan" && lastCtx) refresh(lastCtx, status.toolCallId);
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		if (currentMode === "plan") refresh(ctx);
	});
	// The plan file and its run follow the branch (both are read from it): a
	// /tree switch takes the selected branch's, or allocates one there.
	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		if (currentMode === "plan") refresh(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		lastCtx = ctx;
		if (currentMode === "plan") refresh(ctx);
	});

	// A compaction summarizes the plan away and opens an epoch, where nothing
	// above has to stay byte-stable (R3-M20). Claude Code re-attaches the plan
	// file whenever one exists, plan mode or not (compact.ts
	// createPlanAttachmentIfNeeded); in plan mode the run is recorded again, so
	// the new epoch's block says whether the file exists now.
	pi.on("session_compact", (_event, ctx) => {
		lastCtx = ctx;
		const path = planFileOnBranch(ctx.sessionManager.getBranch());
		if (!path) return;
		if (currentMode === "plan") {
			const before = runOnBranch(ctx, path)?.modeBeforePlan;
			recordState(pi, PLAN_ENTRY_STATE, { path, existed: existsSync(path), ...(before ? { modeBeforePlan: before } : {}) });
			refresh(ctx);
		}
		const content = existsSync(path) ? readFileSync(path, "utf8") : "";
		if (!content.trim()) return;
		pi.events.emit(REMINDER_CHANNEL, { text: planFileReferenceText(path, content), placement: "user-prepend", orTail: true, untilCompaction: true });
	});

	/**
	 * enter_plan_mode's description follows the model's tier: Claude Code's,
	 * which prefers plan mode, on frontier and workhorse, and One Code's, which
	 * says most tasks do not need it, on cheap and tiny (`texts.ts`, through the
	 * shared lib/tool-variants.ts). A re-registration keeps the tool's active
	 * state, so the deferred tool stays deferred, and it sets no prompt snippet,
	 * so the system prompt never moves with it.
	 */
	registerFormTool(
		pi,
		defineTool({
			name: "enter_plan_mode",
			label: "Enter plan mode",
			...ccToolRenderers("Enter plan mode"),
			description: ENTER_PLAN_MODE_DESCRIPTION,
			parameters: Type.Object({}),
			async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
				pi.events.emit(MODE_CHANNEL, { mode: "plan", toolCallId });
				// setMode broadcasts synchronously over the status channel, so the
				// listener above has already installed the block and announced the
				// path (or the mode was plan already and both stand); name the file in
				// the tool result too so the model can start writing this same turn.
				const path = ensurePlanFile(ctx);
				return {
					content: [{ type: "text", text: enteredPlanModeText(path) }],
					details: { planFilePath: path },
				};
			},
		}),
		enterPlanModeDescription,
	);

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		...ccToolRenderers("Exit plan mode"),
		description: EXIT_PLAN_MODE_DESCRIPTION,
		parameters: Type.Object({}),
		async execute(toolCallId, _params, signal, _onUpdate, ctx) {
			// Guard the out-of-sequence call: without this, a cold exit_plan_mode
			// (never entered plan mode) allocates a fresh empty plan file and blames
			// "the plan file is empty" — a plausible but wrong cause a weak model
			// then chases. The real fix is to enter plan mode first.
			if (currentMode !== "plan") {
				return {
					content: [
						{
							type: "text",
							text: "Not in plan mode, so there is no plan to approve. Call enter_plan_mode first, build the plan in the file it names, then call exit_plan_mode.",
						},
					],
					details: {},
					isError: true,
				};
			}
			const path = ensurePlanFile(ctx);
			const plan = existsSync(path) ? readFileSync(path, "utf8") : "";
			if (!plan.trim()) {
				return {
					content: [
						{
							type: "text",
							text: `No plan to approve: ${path} is missing or empty. Write your plan there first, then call exit_plan_mode again.`,
						},
					],
					details: { planFilePath: path },
					isError: true,
				};
			}

			// Plan approval is the user's: with no UI there is no one to approve, and
			// until 2026-09-05 the model exited plan mode by itself here — a
			// `-p --permission-mode plan` run was read-only in name only, since the
			// user's allow rules applied the moment the mode became default
			// (PERMISSIONS-REVIEW-2026-09-05 M4, measured: `git add -A` ran). The
			// session stays in plan mode; the plan file is the run's product.
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `Plan approval needs an interactive session, and this one has no user to approve it. The session stays in plan mode; the plan is recorded at ${path} for the user to review. Do not try to implement it here.`,
						},
					],
					details: { planFilePath: path, plan, approved: false },
					isError: true,
				};
			}

			// The mode the session was in before planning leads the list (Claude
			// Code restores it), then auto mode when a classifier model is reachable —
			// the same gate the mode cycle uses (permissions/index.ts autoInCycle) —
			// and the fixed choices. Each approving choice carries the mode it
			// switches to; the final "Keep planning" choice has none and leaves the
			// session in plan mode.
			const autoAvailable = ctx.modelRegistry.getAvailable().length > 0;
			const modeBeforePlan = runOnBranch(ctx, path)?.modeBeforePlan;
			const restore = modeBeforePlan && (modeBeforePlan !== "auto" || autoAvailable) ? modeBeforePlan : undefined;
			const fixedModes: PermissionMode[] = [...(autoAvailable ? (["auto"] as const) : []), "acceptEdits", "default"];
			const options: { label: string; mode?: PermissionMode; restore?: boolean }[] = [
				...(restore ? [{ label: `Approve — back to ${MODE_NAMES[restore]} (the mode before planning)`, mode: restore, restore: true }] : []),
				...fixedModes.filter((mode) => mode !== restore).map((mode) => ({ label: `Approve — ${MODE_NAMES[mode]}`, mode })),
				{ label: "Keep planning" },
			];
			const choices = options.map((o) => o.label);

			// The plan renders as Markdown, like assistant text in the transcript.
			const prose = canShowCustomUi(ctx) ? await planMarkdown() : undefined;
			const planRef = {};
			const markdown = prose ? (text: string, width: number) => prose(planRef, text, width) : undefined;

			// The scroll position and the highlighted choice outlive one showing: a
			// blank keep-planning answer reopens the dialog where the user left it.
			const maxVisible = 12;
			let offset = 0;
			let selected: PlanChoice = initialPlanChoice(options);
			const showDialog = (): Promise<PlanChoice | null> => !canShowCustomUi(ctx) ? selectPlanChoice(ctx.ui, plan, path, choices, signal) : panelUi(pi.events, ctx.ui).custom<PlanChoice | null>((tui, theme, _keybindings, close) => {
				// An aborted turn closes the dialog as a cancel; a choice or a cancel
				// drops the abort listener. Either way the dialog settles once.
				let settled = false;
				const onAbort = () => done(null);
				const done = (choice: PlanChoice | null) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					close(choice);
				};
				if (signal?.aborted) queueMicrotask(onAbort);
				else signal?.addEventListener("abort", onAbort, { once: true });
				const paint = safeThemePaint(theme);
				let lineCount = 0;
				// The dialog stays open while exit_plan_mode runs, so pi's working
				// spinner drives ~8 frames a second — and re-wrapping the whole plan
				// each frame burned 5–17 ms on a long plan (TUI-REVIEW M1). The plan
				// is immutable for the dialog's life: wrap once per width, and cache
				// the rendered frame by (width, offset, selected) so a steady frame
				// costs nothing. invalidate() (theme swap) drops both.
				// Only one width is ever live at a time (a resize is the only thing that
				// changes it), so a single-slot memo is enough — like the model picker's.
				let wrapped: { width: number; lines: string[] } | undefined;
				let frame: { key: string; lines: string[] } | undefined;
				const wrapAt = (wrapWidth: number): string[] => {
					if (wrapped?.width !== wrapWidth) wrapped = { width: wrapWidth, lines: planLines(plan, wrapWidth, markdown) };
					return wrapped.lines;
				};
				return {
					render: (width: number) => {
						const lines = wrapAt(Math.max(10, width - 1));
						lineCount = lines.length;
						offset = clampOffset(offset, lineCount, maxVisible);
						const key = `${width}:${offset}:${selected}`;
						if (frame?.key === key) return frame.lines;
						const rendered = renderPlanViewer({ lines, offset, choice: selected, choices, maxVisible }, paint, width);
						frame = { key, lines: rendered };
						return rendered;
					},
					handleInput: (data: string) => {
						const key = decodeViewerKey(data, maxVisible);
						if (!key) return;
						if (key.kind === "cancel") return done(null);
						if (key.kind === "confirm") return done(selected);
						if (key.kind === "pick") return key.index < options.length ? done(key.index) : undefined;
						if (key.kind === "scroll") offset = clampOffset(offset + key.delta, lineCount, maxVisible);
						else if (key.kind === "choice")
							selected = (((selected + key.delta) % options.length) + options.length) % options.length;
						tui.requestRender();
					},
					invalidate: () => {
						wrapped = undefined;
						frame = undefined;
					},
				};
			});
			const decision = await runPlanApproval(
				options,
				showDialog,
				() => ctx.ui.input(KEEP_PLANNING_QUESTION, undefined, { signal }),
				signal,
			);

			const picked = decision.kind === "approve" ? options[decision.index] : undefined;
			if (picked?.mode) {
				pi.events.emit(MODE_CHANNEL, { mode: picked.mode, toolCallId });
				// Claude Code's exit reminder, queued from execute so it is written
				// into this result after the mode notice.
				pi.events.emit(REMINDER_CHANNEL, { text: exitedPlanModeText(path), toolCallId });
				return {
					content: [{ type: "text", text: approvedPlanText(path, plan) }],
					details: { plan, approved: true },
				};
			}

			// Rejected: Claude Code's rejection text. With the user's words the model
			// acts on them and keeps planning; without (Esc) the turn stops, as a
			// reasonless permission rejection does (permissions/index.ts): `terminate`
			// ends pi's loop after the batch, and the abort waits for the recorded
			// result so the run ends as the user's interrupt.
			const feedback = decision.kind === "reject" ? decision.feedback : undefined;
			const stop = !feedback;
			if (stop) abortAfterResult.add(toolCallId);
			return {
				content: [{ type: "text", text: userDenialText(feedback) }],
				details: { plan, approved: false, ...(feedback ? { feedback } : {}) },
				isError: true,
				...(stop ? { terminate: true } : {}),
			};
		},
	});

	// Claude Code defers both plan-mode tools behind ToolSearch: they are absent
	// from the wire tool list and its system prompt never mentions plan mode, so
	// the model must deliberately load them before planning. Keeping them
	// always-active (with a prompt snippet) read as standing "plan first" policy
	// to instruction-eager third-party models, which then entered plan mode for
	// trivial tasks. User-initiated plan mode (mode cycling, defaultMode) is
	// unaffected — that flows over MODE_CHANNEL, not through these tools.
	pi.events.emit(DEFER_CHANNEL, {
		name: "enter_plan_mode",
		keywords: ["plan", "planning", "design", "approach", "architecture", "investigate", "read-only"],
	});
	pi.events.emit(DEFER_CHANNEL, {
		name: "exit_plan_mode",
		keywords: ["plan", "approve", "approval", "present", "finish planning"],
	});
}
