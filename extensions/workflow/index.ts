/**
 * workflow extension — Claude Code's Workflow ("ultracode") tool.
 *
 * The model authors a small JavaScript orchestration script (leading
 * `export const meta = {...}`, then agent()/parallel()/pipeline()/phase()/
 * log()/args/budget) that fans work out across many in-process subagents.
 * Runs go to the background by default: the tool returns a runId immediately
 * and the result arrives later as a follow-up message. Scripts and per-call
 * journals persist under the session dir, so `resumeFromRunId` replays the
 * unchanged prefix of an edited or interrupted run. Saved workflows live in
 * `.claude/workflows/` (project) and `~/.claude/workflows/` (user), or their
 * `.onecode` twins in independent mode (lib/config-mode.ts).
 *
 * The description is Claude Code's (description.ts); the authoring reference
 * it points to is the bundled `workflow-authoring` skill. `enableWorkflows`,
 * `disableWorkflows` and `workflowSizeGuideline` come from One Code's settings.
 *
 * Orchestration is opt-in, like Claude Code: the tool description gates it,
 * and the literal keyword "ultracode" in a user message arms the turn via a
 * system reminder (skipped while `/effort ultracode` has the standing block
 * on — see `effort/`). The keyword is read by pi's `input` event; on pi 0.86+
 * that includes a message queued mid-turn, whose reminder is held until pi
 * delivers the message. On older pi a queued message does not arm.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recordUsage } from "../lib/usage-bus.ts";
import { readWorkflowSettings } from "../lib/one-code-settings.ts";
import { registerVariantTool } from "../lib/tool-variants.ts";
import { workflowDescription } from "./description.ts";
import { MODEL_UNUSABLE_CHANNEL, type ModelUnusableEvent } from "../lib/model-unusable.ts";
import { whenAborted } from "../lib/abort.ts";
import { createTaskNotifier, oneShotNote, sessionOutlivesTurn, taskNotification, taskStatusOf, workflowSummary } from "../lib/notifications.ts";
import { QueuedDelivery } from "../lib/queued-delivery.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { ULTRACODE_MODE_CHANNEL } from "../effort/slider.ts";
import { PERMISSION_STATUS_CHANNEL } from "../permissions/modes.ts";
import { watchPermissionBridge } from "../permissions/subagent-gate.ts";
import { watchHookBridge } from "../hooks/subagent-bridge.ts";
import { watchMcpTools } from "../lib/mcp-share.ts";
import { applicableSubagentDefault, loadSubagentDefault } from "../subagents/default-model.ts";
import { discoverSavedWorkflows, findSavedWorkflow, workflowDirs } from "./saved-workflows.ts";
import { buildRunReport, type RunHandle, WorkflowRunManager } from "./run-manager.ts";
import {
	ccToolRenderers,
	customMessageText,
	notificationComponent,
	safeThemeBold,
	safeThemePaint,
	truncateLine,
} from "../lib/tui-render.ts";
import { WorkflowScriptError } from "./types.ts";
import {
	clampViewerState,
	decodeStatusKey,
	decodeViewerKey,
	initialViewerState,
	planSave,
	renderViewer,
	type ViewerRunSnapshot,
} from "./viewer.ts";
import { WorkflowWidget } from "./widget.ts";
import { registerLocalCommand } from "../lib/local-command.ts";
import { sessionWorkCwd } from "../lib/worktree-channel.ts";
import { followEnteredWorktree } from "../lib/worktree-isolation.ts";
import { isKeyRelease, keyId } from "../lib/key-input.ts";
import { projectConfigDirName } from "../lib/config-mode.ts";

/**
 * Claude Code's own arming reminder, verbatim in intent: the keyword is a
 * standing opt-in for the turn, delivered as a system-reminder rather than
 * anything the model has to notice on its own.
 */
const ULTRACODE_REMINDER =
	'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.';

// Claude Code's parameter texts, with One Code's tool names; `name` also
// names the personal directory, and a run is stopped with /workflows stop.
const WorkflowParams = Type.Object({
	script: Type.Optional(
		Type.String({
			description:
				"Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
		}),
	),
	name: Type.Optional(
		Type.String({ description: `Name of a saved workflow from ${projectConfigDirName()}/workflows/ or ~/${projectConfigDirName()}/workflows/. Resolves to a self-contained script.` }),
	),
	args: Type.Optional(
		Type.Any({
			description:
				"Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
		}),
	),
	scriptPath: Type.Optional(
		Type.String({
			description:
				"Path to a workflow script file on disk. Every workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with write/edit and re-invoke workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
		}),
	),
	resumeFromRunId: Type.Optional(
		Type.String({
			pattern: "^wf_[a-z0-9-]{6,}$",
			description:
				"Run ID of a prior workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (/workflows stop) before resuming.",
		}),
	),
	tokenBudget: Type.Optional(
		Type.Integer({
			minimum: 1000,
			description: "Output-token target shared by the run and nested workflows. Stops new and queued agents once reached; already-running agents may exceed it. Exposed as budget {total, spent(), remaining()}",
		}),
	),
	sync: Type.Optional(
		Type.Boolean({ description: "Run in the foreground, blocking until the workflow finishes (default: background)" }),
	),
});

export default function workflowExtension(pi: ExtensionAPI) {
	// Models the account refused this session (classifier/subagent reports, lib/model-unusable.ts):
	// workflow agents share the subagent selector, so they resolve around them too.
	const unusableModels = new Set<string>();
	pi.events.on(MODEL_UNUSABLE_CHANNEL, (data) => {
		unusableModels.add((data as ModelUnusableEvent).model);
	});
	const notifyTask = createTaskNotifier(pi);
	// After `enter_worktree`, workflow agents run in the worktree (and are guarded there).
	const enteredWorktree = followEnteredWorktree(pi.events);
	const manager = new WorkflowRunManager();
	let lastCtx: ExtensionContext | undefined;
	const widget = new WorkflowWidget(manager, () => lastCtx);
	let viewerOpen = false;

	// Parent permission bridge for workflow agents' gates — same bridge the
	// subagent runner uses; see AgentRunnerOptions.getPermissionBridge.
	const getPermissionBridge = watchPermissionBridge(pi);
	const getHookBridge = watchHookBridge(pi);
	// The parent's MCP tools, shared into workflow agents as they are into subagents.
	const getMcpTools = watchMcpTools(pi.events);

	const openViewer = async (ctx: ExtensionContext, opts?: { height?: "full" | "half"; runIndex?: number }) => {
		if (viewerOpen) return;
		viewerOpen = true;
		try {
			await openWorkflowViewer(ctx, manager, opts);
		} finally {
			viewerOpen = false;
		}
	};

	/**
	 * A background run's result notification, sent once when that run finishes.
	 * Keyed by the handle, not the run id: a `resumeFromRunId` run reuses its
	 * original id, and a set of delivered ids swallowed the resumed run's result
	 * (SUBAGENTS-WORKFLOWS-REVIEW-2026-09-26 H4). `toolUseId` is the call that
	 * started this run, the notification's `<tool-use-id>`.
	 */
	const deliverResult = (handle: RunHandle, toolUseId: string) => {
		// CC's kind=workflow task notification; the run report (result or the
		// failure and how to resume) is its `<result>`. Summary literal: see
		// workflowSummary — unverified against CC.
		const status = taskStatusOf(handle.status);
		notifyTask(
			"one-code:workflow-result",
			taskNotification({
				kind: "workflow",
				taskId: handle.runId,
				toolUseId,
				status,
				summary: workflowSummary(handle.meta.name, status, status === "completed" ? undefined : handle.errorMessage),
				result: buildRunReport(handle),
			}),
			{ runId: handle.runId, name: handle.meta.name, status: handle.status },
		);
	};

	pi.registerMessageRenderer("one-code:workflow-result", (message, { expanded }, theme) =>
		notificationComponent(theme, customMessageText(message.content), expanded),
	);

	// The description carries the session's size guideline (description.ts);
	// it is read from One Code's settings at session start and the tool is
	// registered again only when the line changes.
	const workflowTool = defineTool({
		name: "workflow",
		label: "Workflow",
		...ccToolRenderers<
			{ name?: string; scriptPath?: string; script?: string; resumeFromRunId?: string },
			{ runId?: string; background?: boolean }
		>("Workflow", {
			title: (a) => a?.name ?? a?.scriptPath ?? (a?.resumeFromRunId ? `resume ${a.resumeFromRunId}` : a?.script ? "inline script" : undefined),
			// The model-facing start text is instructions, not information — show
			// the user Claude Code's hint line instead.
			result: (result, _args, isError) =>
				!isError && result.details?.background
					? `Running in background · /workflows to monitor and save · ${result.details.runId ?? ""}`.trimEnd()
					: undefined,
		}),
		description: workflowDescription("medium", false),
		promptSnippet: "Run a script that orchestrates many subagents (opt-in ultracode mode)",
		parameters: WorkflowParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			const sessionDir = ctx.sessionManager.getSessionDir();

			let script: string | undefined;
			try {
				// Settings that turn workflows off also refuse a call that reaches
				// the tool anyway (a later setActiveTools can bring it back).
				if (!workflowsEnabled) {
					throw new WorkflowScriptError(
						"Workflows are turned off: enableWorkflows is false or disableWorkflows is true in One Code's user or project settings. Turn them back on there and start a new session.",
					);
				}
				// `scriptPath` takes precedence over `script` and `name`, as in Claude Code.
				if (params.scriptPath) {
					if (!existsSync(params.scriptPath)) throw new WorkflowScriptError(`scriptPath ${params.scriptPath} does not exist`);
					script = readFileSync(params.scriptPath, "utf8");
				}
				script ??= params.script;
				if (!script && params.name) {
					const saved = findSavedWorkflow(ctx.cwd, os.homedir(), params.name);
					if (!saved) {
						const known = discoverSavedWorkflows(ctx.cwd, os.homedir()).map((w) => w.name);
						throw new WorkflowScriptError(
							`No saved workflow named "${params.name}". Available: ${known.join(", ") || "(none)"}`,
						);
					}
					script = readFileSync(saved.path, "utf8");
				}
				if (!script && params.resumeFromRunId) {
					const storedScript = join(sessionDir, "workflows", params.resumeFromRunId, "script.js");
					if (!existsSync(storedScript)) {
						throw new WorkflowScriptError(`resumeFromRunId ${params.resumeFromRunId} has no stored script`);
					}
					script = readFileSync(storedScript, "utf8");
				}
				if (!script) {
					throw new WorkflowScriptError("Pass one of: script, scriptPath, name, or resumeFromRunId");
				}

				const configuredDefault = applicableSubagentDefault(loadSubagentDefault(os.homedir()), ctx.model);
				const handle = manager.start({
					script,
					args: params.args,
					tokenBudget: params.tokenBudget ?? null,
					resumeFromRunId: params.resumeFromRunId,
					// Where the session works: the entered worktree, if any (pi keeps ctx.cwd at the original checkout).
					cwd: sessionWorkCwd(enteredWorktree(), ctx.cwd),
					sessionDir,
					defaultModel: ctx.model,
					configuredDefault,
					defaultEffort: ctx.thinkingLevel,
					getPermissionBridge,
					getHookBridge,
					getMcpTools,
					// Workflow agents run in their own sessions; their spend reaches the footer only through the bus.
					onUsage: (cost) => recordUsage(pi, "subagent", { cost: { total: cost } }),
					unusableModels: () => unusableModels,
					onModelUnusable: (model, reason) => {
						if (unusableModels.has(model)) return;
						unusableModels.add(model);
						pi.events.emit(MODEL_UNUSABLE_CHANNEL, { model, reason } satisfies ModelUnusableEvent);
					},
				});
				widget.attach(handle);

				// One-shot modes (`-p` / `--mode json`) exit when the turn settles:
				// session_shutdown aborts every run, so a backgrounded workflow never
				// finished and its promised follow-up never came (LIFECYCLE-REVIEW
				// M1, measured: no result, no journal). Run it to completion there,
				// the rule bash and Agent apply, and return the report in the result.
				const forcedSync = !params.sync && !sessionOutlivesTurn(ctx.mode);
				if (params.sync || forcedSync) {
					const onProgress = () => {
						onUpdate?.({
							content: [{ type: "text", text: handle.recentEvents.slice(-8).join("\n") || "starting…" }],
							details: { runId: handle.runId },
						});
					};
					handle.on("progress", onProgress);
					const unhookAbort = whenAborted(signal, () => handle.abort("tool call aborted"));
					try {
						await handle.finished;
					} finally {
						unhookAbort();
						handle.removeListener("progress", onProgress);
					}
					const oneShotPrefix = forcedSync ? `${oneShotNote("workflow")}\n\n` : "";
					return {
						content: [{ type: "text", text: `${oneShotPrefix}${buildRunReport(handle)}` }],
						details: { runId: handle.runId, status: handle.status, scriptPath: handle.scriptPath },
						isError: handle.status !== "completed",
					};
				}

				void handle.finished.then(() => deliverResult(handle, toolCallId));
				return {
					content: [
						{
							type: "text",
							text:
								`Workflow **${handle.meta.name}** ${handle.resumed ? "resumed" : "started"} in the background.\n` +
								`runId: ${handle.runId}\nscript: ${handle.scriptPath}\n` +
								"The result will arrive as a task notification when the run finishes. " +
								"You know nothing about its outcome until then — do not predict it. " +
								"The user can watch with /workflows and stop with /workflows stop.",
						},
					],
					details: { runId: handle.runId, background: true, scriptPath: handle.scriptPath },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: {},
					isError: true,
				};
			}
		},
	});
	const setWorkflowDescription = registerVariantTool<string>(pi, workflowTool.description, (description) => ({ ...workflowTool, description }));

	// `enableWorkflows`/`disableWorkflows` and `workflowSizeGuideline` from One
	// Code's settings, read once per session so the description stays
	// byte-stable within it. Turned off, the tool leaves the active set (and
	// comes back if a later session turns it on) and the keyword arms nothing.
	let workflowsEnabled = true;
	let workflowWithheld = false;
	const applyWorkflowSettings = (cwd: string) => {
		const settings = readWorkflowSettings(cwd, os.homedir());
		workflowsEnabled = settings.enabled;
		setWorkflowDescription(workflowDescription(settings.sizeGuideline, settings.sizeConfigured));
		const active = pi.getActiveTools();
		if (!settings.enabled && active.includes("workflow")) {
			pi.setActiveTools(active.filter((name) => name !== "workflow"));
			workflowWithheld = true;
		} else if (settings.enabled && workflowWithheld) {
			if (!active.includes("workflow")) pi.setActiveTools([...active, "workflow"]);
			workflowWithheld = false;
		}
	};

	registerLocalCommand(pi, "workflows", {
		description: "Open the workflow viewer; list, stop, or inspect runs",
		argumentHint: "[list|log <run-id>|stop <run-id>]",
		getArgumentCompletions: (prefix) => {
			const items = ["stop ", "log ", "list"].filter((c) => c.startsWith(prefix));
			return items.length ? items.map((c) => ({ value: c, label: c.trim() })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const [action, runId] = args.trim().split(/\s+/);
			if (!action && ctx.hasUI && ctx.mode === "tui") {
				await openViewer(ctx, { height: "full" });
				return;
			}
			if (action === "stop" && runId) {
				const stopped = manager.abort(runId, "stopped via /workflows");
				ctx.ui.notify(stopped ? `Stopping ${runId}…` : `No running workflow ${runId}`, stopped ? "info" : "error");
				return;
			}
			if (action === "log" && runId) {
				const handle = manager.get(runId);
				if (!handle) {
					ctx.ui.notify(`No workflow run ${runId} in this session`, "error");
					return;
				}
				ctx.ui.notify(`${handle.meta.name} (${handle.status})\n${handle.recentEvents.join("\n") || "(no events)"}`, "info");
				return;
			}

			const lines: string[] = [];
			const runs = manager.list();
			if (runs.length) {
				lines.push("Runs this session:");
				for (const h of runs) {
					const state = h.state;
					lines.push(
						`  ${h.runId} ${h.meta.name} — ${h.status}${state ? ` (${state.agentCount()} agents, ${state.outputTokens()} out-tokens)` : ""}`,
					);
				}
			}
			const saved = discoverSavedWorkflows(ctx.cwd, os.homedir());
			if (saved.length) {
				lines.push("Saved workflows:");
				for (const w of saved) lines.push(`  ${w.name} (${w.source}) — ${w.meta?.description ?? w.path}`);
			}
			if (!lines.length) lines.push(`No workflow runs yet and no saved workflows found (${projectConfigDirName()}/workflows/).`);
			if (!action && ctx.mode === "rpc") lines.unshift("The interactive workflow viewer requires TUI mode; listing workflows instead.");
			lines.push("Usage: /workflows [stop <runId> | log <runId>]");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// While ultracode MODE is on (/effort ultracode) the standing block already
	// carries the opt-in, so the keyword's single-turn one-shot is skipped: one
	// instruction for one fact. Since pi 0.86 `input` also fires for a message
	// queued mid-turn; its one-shot waits until pi delivers that message
	// (lib/queued-delivery.ts), or it would ride the running tool's result, before
	// the message. On older pi a queued message never reaches `input` and the
	// keyword arms nothing (the mode covers it).
	let ultracodeMode = false;
	pi.events.on(ULTRACODE_MODE_CHANNEL, (data) => {
		ultracodeMode = (data as { active?: boolean })?.active === true;
	});
	const queuedKeyword = new QueuedDelivery<true>();
	pi.on("input", (event) => {
		if (!workflowsEnabled || ultracodeMode || !/\bultracode\b/i.test(event.text)) return undefined;
		if (event.streamingBehavior) queuedKeyword.hold(event.text, true);
		else pi.events.emit(REMINDER_CHANNEL, { text: ULTRACODE_REMINDER, scope: "next-turn" });
		return undefined;
	});
	pi.on("message_start", (event) => {
		if (queuedKeyword.isEmpty || event.message.role !== "user") return;
		if (queuedKeyword.release(contentText(event.message.content, ""))) pi.events.emit(REMINDER_CHANNEL, { text: ULTRACODE_REMINDER, placement: "last-append" });
	});
	pi.on("agent_settled", () => queuedKeyword.clear());

	// Down-arrow soft focus for the below-editor status strip (Claude Code's
	// bottom workflow entry): with the editor focused and empty, ↓ highlights
	// the newest run's row; ↑/↓ move, enter opens the half-screen viewer, x
	// stops the run, esc — or typing anything — returns to the editor. The
	// listener runs before the focused component sees the byte, so every
	// consume is guarded by "the core editor really has focus" (identity
	// against the captured baseline) to never steal keys from dialogs.
	let inputHookRegistered = false;
	const registerInputHook = (registerCtx: ExtensionContext) => {
		if (inputHookRegistered || !registerCtx.hasUI) return;
		inputHookRegistered = true;
		const leave = () => widget.setFocus(undefined);
		try {
			registerCtx.ui.onTerminalInput((data) => {
				// pi-tui calls input listeners before it filters key releases, and a
				// kitty terminal sends one after every press: never a key here.
				if (isKeyRelease(data)) return undefined;
				// Session switches replace the ExtensionContext; the hook registers
				// once, so it must act through the freshest ctx, not its closure.
				const ctx = lastCtx ?? registerCtx;
				if (viewerOpen || !widget.rowCount()) {
					if (widget.focusIndex !== undefined) leave();
					return undefined;
				}
				if (widget.focusIndex === undefined) {
					if (keyId(data) !== "down" || !widget.editorFocusedAndIdle(ctx)) return undefined;
					widget.setFocus(0);
					return { consume: true };
				}
				// Focus moved to a dialog/overlay since the strip took soft focus —
				// drop it and let the dialog have the key.
				if (!widget.editorFocused()) {
					leave();
					return undefined;
				}
				const key = decodeStatusKey(data);
				if (!key) {
					leave();
					return undefined; // typing resumes in the editor, byte included
				}
				switch (key) {
					case "up":
						if (widget.focusIndex === 0) leave();
						else widget.setFocus(widget.focusIndex - 1);
						return { consume: true };
					case "down":
						widget.setFocus(Math.min(widget.rowCount() - 1, widget.focusIndex + 1));
						return { consume: true };
					case "leave":
						leave();
						// While the model streams, esc must still interrupt it — drop the
						// soft focus and let the byte through; consumed only when idle.
						return ctx.isIdle() ? { consume: true } : undefined;
					case "stop": {
						const run = widget.selectedRun();
						if (run) manager.abort(run.runId, "stopped from status strip");
						return { consume: true };
					}
					case "open": {
						const runIndex = widget.focusIndex;
						leave();
						void openViewer(ctx, { height: "half", runIndex });
						return { consume: true };
					}
				}
			});
		} catch {
			// Mode without raw terminal input (print/RPC) — the strip is view-only.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		queuedKeyword.clear();
		applyWorkflowSettings(ctx.cwd);
		registerInputHook(ctx);
	});

	// The permission-mode badge is a below-editor widget too, re-set on every
	// mode change; setWidget order is last-write order, so re-set the strip
	// whenever the badge changes to keep it beneath the mode line (CC's order).
	pi.events.on(PERMISSION_STATUS_CHANNEL, () => widget.refresh());

	pi.on("session_shutdown", () => {
		// Fires on /clear, /new and /resume too (findings §8): after this the ctx
		// is invalid, so nothing below may paint on it.
		manager.abortAll("session ended");
		widget.dispose();
		lastCtx = undefined;
	});
}

/**
 * The interactive workflow viewer (Claude Code's /workflows screen). All
 * layout/key logic is pure in viewer.ts; this component owns only mutable
 * state, the repaint ticker, and the save-to-.claude/workflows fs work.
 *
 * Liveness comes from a 500ms ticker (invalidate + requestRender) instead of
 * per-RunHandle subscriptions — it also picks up runs that start while the
 * viewer is open, and the memoized render keeps the per-frame cost at a map
 * lookup (findings §15).
 */
async function openWorkflowViewer(
	ctx: ExtensionContext,
	manager: WorkflowRunManager,
	opts?: { height?: "full" | "half"; runIndex?: number },
): Promise<void> {
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
		const paint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme) };

		// Newest run first, so the viewer opens on the latest.
		const snapshots = (): ViewerRunSnapshot[] => manager.snapshots();

		// Full (the /workflows tab) fills the terminal; half (opened from the
		// status strip) leaves the transcript visible above, like Claude Code.
		const viewerHeight = (rows: number): number =>
			opts?.height === "half" ? Math.max(12, Math.min(Math.floor(rows / 2), 30)) : Math.max(12, rows - 2);

		const state = initialViewerState(opts?.runIndex ?? 0);
		let cache: { width: number; lines: string[] } | undefined;
		const repaint = () => {
			cache = undefined;
			tui.requestRender();
		};
		const ticker = setInterval(repaint, 500);
		ticker.unref?.();

		const save = (runs: ViewerRunSnapshot[]) => {
			const run = runs[state.runIndex];
			const handle = run && manager.get(run.runId);
			if (!handle) return;
			try {
				const source = readFileSync(handle.scriptPath, "utf8");
				const dir = workflowDirs(ctx.cwd, os.homedir()).project;
				const safeName = run.name.replace(/[^A-Za-z0-9._-]/g, "-");
				const target = join(dir, `${safeName}.js`);
				const exists = existsSync(target);
				const sameContent = exists && readFileSync(target, "utf8") === source;
				const plan = planSave({ name: safeName, exists, sameContent, confirmed: state.confirmOverwrite });
				if (plan.action === "write") {
					mkdirSync(dir, { recursive: true });
					writeFileSync(target, source, "utf8");
					state.confirmOverwrite = false;
				} else if (plan.action === "confirm") {
					state.confirmOverwrite = true;
				}
				state.notice = plan.notice;
			} catch (error) {
				state.notice = `save failed: ${(error as Error).message}`;
				state.confirmOverwrite = false;
			}
		};

		return {
			render: (width: number) => {
				if (cache?.width === width) return cache.lines;
				const height = viewerHeight(tui.terminal.rows);
				const lines = renderViewer({ runs: snapshots(), state, width, height, now: Date.now() }, paint).map(
					(line) => truncateLine(line, width),
				);
				cache = { width, lines };
				return lines;
			},
			handleInput: (data: string) => {
				const key = decodeViewerKey(data);
				if (!key) return;
				const close = () => {
					clearInterval(ticker);
					done(null);
				};
				if (key.kind === "close") return close();
				if (key.kind !== "save") {
					state.notice = undefined;
					state.confirmOverwrite = false;
				}
				switch (key.kind) {
					case "up":
					case "down": {
						const delta = key.kind === "up" ? -1 : 1;
						if (state.level === "phases") state.phaseCursor += delta;
						else state.agentCursor += delta;
						clampViewerState(state, snapshots());
						state.detailScroll = 0;
						state.promptExpanded = false;
						break;
					}
					case "enter":
						// Phases level drills into the phase; agents level toggles the prompt.
						if (state.level === "phases") {
							state.level = "agents";
							state.agentCursor = 0;
							state.detailScroll = 0;
							state.promptExpanded = false;
							clampViewerState(state, snapshots()); // falls back if the phase has no agents
						} else {
							state.promptExpanded = !state.promptExpanded;
						}
						break;
					case "back":
						if (state.level === "agents") {
							state.level = "phases";
							state.detailScroll = 0;
							state.promptExpanded = false;
							break;
						}
						return close();
					case "pageUp":
					case "pageDown":
						// Clamped against the detail's real length at render time.
						state.detailScroll = Math.max(0, state.detailScroll + (key.kind === "pageUp" ? -8 : 8));
						break;
					case "nextRun": {
						const count = manager.list().length;
						state.runIndex = count ? (state.runIndex + 1) % count : 0;
						state.level = "phases";
						state.phaseCursor = 0;
						state.agentCursor = 0;
						state.detailScroll = 0;
						state.promptExpanded = false;
						break;
					}
					case "stop": {
						const run = snapshots()[state.runIndex];
						const stopped = run && manager.abort(run.runId, "stopped from viewer");
						state.notice = stopped ? `stopping ${run.runId}…` : "workflow is not running";
						break;
					}
					case "save":
						save(snapshots());
						break;
				}
				repaint();
			},
			invalidate: () => {
				cache = undefined;
			},
			// Covers every dismissal path that isn't the user pressing esc while
			// focused (session end, another overlay taking over) — without it the
			// ticker outlives the component.
			dispose: () => {
				clearInterval(ticker);
			},
		};
	});
}
