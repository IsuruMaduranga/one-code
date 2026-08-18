/**
 * subagents extension — Claude Code's Agent/Task tool, plus send_message.
 *
 * Delegates a task to a specialist agent running in-process (its own
 * AgentSession, see runner.ts) with its own context window. Agent definitions
 * come from `.claude/agents/*.md`
 * (project), `~/.claude/agents/*.md` (user), and the catalog bundled with this
 * package — the same markdown + frontmatter format Claude Code uses.
 *
 * Claude Code features covered: parallel tasks, per-call `model`/`thinking`
 * overrides, `fork` (a child inheriting this conversation), `isolation:
 * "worktree"`, `run_in_background` (detached runs addressable via
 * task_output/task_stop, completion delivered as a system notification), and
 * send_message (resume a finished agent with its context intact — children
 * persist their sessions per run to make that possible).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../auto-mode/actions.ts";
import { type AgentDefinition, type AgentSource, agentDirs, discoverAgents } from "./agents.ts";
import { modelIdentity, modelSpec } from "../lib/model-policy.ts";
import { applicableSubagentDefault, loadSubagentDefault, persistSubagentModel } from "./default-model.ts";
import {
	expensiveModelGate,
	resolveSubagentModel,
	type SubagentModelResolution,
	SUBAGENT_STATUS_CHANNEL,
	subagentModelsReminder,
	subagentStatusModel,
} from "./model-select.ts";
import { modelPickerComponent, pickerSpec, toPickerEntries, type PickerEntry } from "../auto-mode/model-picker.ts";
import { discoverPlugins } from "../lib/plugins.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { MCP_TOOLS_CHANNEL, type McpToolsPayload } from "../lib/mcp-share.ts";
import { type PermissionBridge, SUBAGENT_GATE_CHANNEL, type SubagentGatePayload } from "../permissions/subagent-gate.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { type BackgroundTask, generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import { type ChildAction } from "../auto-mode/actions.ts";
import { type ChildHandle, type ChildOutcome, forkTaskMessage, OUTPUT_CAP, type RpcChildHandle } from "./outcome.ts";
import { type AgentRunRecord, nextRunName, RunRegistry } from "./runs.ts";
import { SubagentRuntime } from "./runner.ts";
import { emptyUsage, formatStats, type UsageTotals } from "./usage.ts";
import { cleanupWorktree, createWorktree, isGitRepo, type Worktree } from "./worktree.ts";
import { systemNotification } from "../lib/notifications.ts";
import { ccToolRenderers, customMessageText, notificationComponent, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { deriveActivity, LiveRunRegistry } from "./live-runs.ts";
import type { LiveSink } from "./runner.ts";
import { SubagentWidget } from "./panel-widget.ts";
import { type ProseRenderer, renderTranscript } from "./panel-render.ts";
import { decodeStripKey } from "./panel-keys.ts";
import { createMarkdownProse } from "./prose.ts";

/** The catalog shipped in this package: <package>/agents. */
const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

interface RunRequest {
	agent: string;
	task: string;
	name: string;
	/** Inherit the caller's conversation instead of starting from an agent prompt. */
	fork?: boolean;
	model?: string;
	/**
	 * Session model to fall back to if `model` (a non-per-call automatic/default
	 * pick) cannot spawn. Unset for a per-call model, which surfaces its error to
	 * the main model to retry rather than being silently swapped. See the runner's
	 * buildChildSession.
	 */
	fallbackModel?: string;
	thinking?: string;
	worktree?: boolean;
}

/**
 * The session model a broken *automatic* pick should fall back to at spawn.
 * Undefined for a per-call model (source "call") — that surfaces its error to
 * the main model to retry rather than being silently swapped — and when the
 * pick already IS the session model. `resolvedSpec` is the caller's already-
 * computed `provider/id` for the resolved model.
 */
function spawnFallbackModel(
	resolvedSpec: string | undefined,
	source: SubagentModelResolution["source"],
	sessionModel: { provider: string; id: string } | undefined,
): string | undefined {
	if (!sessionModel || source === "call" || !resolvedSpec) return undefined;
	const sessionSpec = modelSpec(sessionModel);
	return resolvedSpec !== sessionSpec ? sessionSpec : undefined;
}

interface TaskResult {
	agent: string;
	name: string;
	taskId: string;
	task: string;
	output: string;
	toolCalls: number;
	usage: UsageTotals;
	failed?: boolean;
	worktreePath?: string;
	worktreeKept?: boolean;
	/** What the child did, for auto mode's return review. */
	actions?: ChildAction[];
}

const SubagentParams = Type.Object({
	subagent_type: Type.Optional(
		Type.String({
			description:
				'The agent to run — a name from the "Available agents" system reminder, or "fork" to clone this conversation. Required unless action:"list". To run several in parallel, issue multiple Agent tool calls in one turn.',
		}),
	),
	task: Type.Optional(
		Type.String({ description: "The task — a complete, self-contained instruction (the agent cannot ask follow-ups). Required with subagent_type." }),
	),
	name: Type.Optional(Type.String({ description: "Name for this run, usable later with SendMessage (default: <agent>-<n>)" })),
	model: Type.Optional(
		Type.String({
			description:
				'Override the agent\'s model for this call: "sonnet"/"opus"/"haiku"/"fable" (resolved within this session\'s provider), "inherit", or an exact provider/model-id — see the subagent-models reminder for what is available. Rejected for fork runs (a fork keeps this conversation\'s model)',
		}),
	),
	allow_expensive: Type.Optional(
		Type.Boolean({
			description:
				"Confirm a per-call `model` that costs more per token than this session's model. Set it only when the user explicitly asked for that model",
		}),
	),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high"] as const, {
			description:
				"Override the reasoning effort for this call. Rejected for fork runs (a fork keeps this conversation's settings)",
		}),
	),
	isolation: Type.Optional(
		StringEnum(["worktree"] as const, {
			description: "Run the agent in its own git worktree so its file edits are isolated from the main checkout",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately with a task id instead of waiting. Completion arrives as a system notification; inspect with task_output, stop with task_stop",
		}),
	),
	action: Type.Optional(
		StringEnum(["run", "list"] as const, {
			description: '"run" (the default) executes; "list" only browses the agent catalog and ignores run options',
		}),
	),
});

export const FORK_AGENT = "fork";

/** A background agent's process, kept alive after its run so it can be messaged. */
interface Resident {
	handle: RpcChildHandle;
	/** FIFO — the head entry handles the next turn_end (initial task, then one per idle-time message). */
	turnHandlers: Array<(outcome: ChildOutcome) => void>;
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const registry = new RunRegistry();
	/** Names with a foreground/respawned child currently running (send_message must wait for these). */
	const runningNames = new Set<string>();
	const residents = new Map<string, Resident>();

	// The live subagent panel (Claude Code's below-editor agent tree): a registry
	// of every in-process child fed by the runner's live sink, a below-editor
	// strip, and taskId→kill handles for the viewer's stop/stop-all.
	const liveRuns = new LiveRunRegistry();
	const liveHandles = new Map<string, { kill(): void }>();
	let lastCtx: ExtensionContext | undefined;
	const panel = new SubagentWidget(liveRuns, () => lastCtx);

	/**
	 * Register a child in the live panel and return the wiring the spawn sites
	 * need: a runner `sink` (activity + transcript blocks), a `progress` hook to
	 * fold into the existing onProgress, and settle/finish terminal marks.
	 */
	const trackLiveRun = (record: AgentRunRecord, request: RunRequest, parent?: { taskId: string; depth: number }) => {
		// A resumed run (SendMessage to a finished agent) re-enters its existing
		// panel entry; only a never-seen taskId registers fresh.
		if (!liveRuns.reactivate(record.taskId, request.task, Date.now())) {
			liveRuns.register({
				taskId: record.taskId,
				name: record.name,
				agentType: request.agent,
				model: request.model,
				thinking: request.thinking,
				task: request.task,
				startedAt: Date.now(),
				parentTaskId: parent?.taskId,
				depth: record.depth ?? 0,
			});
		}
		const sink: LiveSink = {
			onActivity: (tool, args, text) => liveRuns.setActivity(record.taskId, deriveActivity(tool, args, text)),
			onBlock: (block) => liveRuns.block(record.taskId, block),
			onStreaming: (message) => liveRuns.setStreaming(record.taskId, message),
		};
		return {
			sink,
			progress: (toolCalls: number, usage: UsageTotals) => liveRuns.stats(record.taskId, toolCalls, usage),
			settle: () => liveRuns.settle(record.taskId),
			finish: (failed: boolean) => {
				liveRuns.finish(record.taskId, failed);
				liveHandles.delete(record.taskId);
			},
		};
	};

	// Live MCP tool definitions published by the mcp extension; injected into
	// child sessions so subagents share the parent's open connections (no reconnect).
	// Empty when no MCP servers are configured, so this is a no-op for most sessions.
	let mcpTools: ToolDefinition[] = [];
	pi.events.on(MCP_TOOLS_CHANNEL, (data) => {
		mcpTools = (data as McpToolsPayload | undefined)?.tools ?? [];
	});

	// The parent permissions extension's decision closure, used to gate a child's
	// tool calls through the real pipeline (mode inheritance, classifier, prompts
	// bubbled to the user). Undefined until permissions emits it at session start;
	// a child built before then falls back to the fail-closed local gate.
	let permissionBridge: PermissionBridge | undefined;
	pi.events.on(SUBAGENT_GATE_CHANNEL, (data) => {
		permissionBridge = (data as SubagentGatePayload | undefined)?.decide;
	});

	/** The in-process runner, built lazily on first run and shared across all runs. */
	let runtimePromise: Promise<SubagentRuntime> | undefined;
	const getRuntime = (ctx: ExtensionContext) =>
		(runtimePromise ??= SubagentRuntime.create(
			ctx.cwd,
			() => mcpTools,
			() => permissionBridge,
		));

	const loadAgents = (cwd: string) => {
		// Plugin agents sit between bundled and user definitions, and are exposed
		// namespaced (`<plugin>:<agent>`) so two plugins can ship the same name.
		const sources: Array<string | AgentSource> = [
			BUNDLED_AGENTS_DIR,
			...discoverPlugins(join(os.homedir(), ".claude")).agentDirs,
			...agentDirs(cwd, os.homedir()),
		];
		return discoverAgents(sources);
	};

	const describeAgents = (cwd: string) => {
		const agents = loadAgents(cwd);
		const lines = agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`);
		lines.push(`- ${FORK_AGENT}: clone this conversation, with its full context, to work on a task in parallel`);
		return lines.join("\n");
	};

	const reconstructRuns = (ctx: ExtensionContext) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			// Both the current names and the pre-rename ones, so runs recorded before the
			// Agent/SendMessage rename still reconstruct on resume.
			if (msg.role !== "toolResult" || !["Agent", "SendMessage", "subagent", "send_message"].includes(msg.toolName ?? "")) continue;
			const records = (msg.details as { agentRuns?: AgentRunRecord[] } | undefined)?.agentRuns;
			for (const record of records ?? []) registry.add(record);
		}
	};
	/** Notices about model fallbacks/crossings, shown once per distinct message. */
	const noticedModels = new Set<string>();
	const notifyModelOnce = (ctx: ExtensionContext, message: string) => {
		if (noticedModels.has(message)) return;
		noticedModels.add(message);
		ctx.ui.notify(message, "warning");
	};

	/**
	 * The every-turn menu reminder and the banner's subagent-default status.
	 * Every-turn because reminders are transient per-request injections — that
	 * scope survives compaction by construction — and keyed so a model change
	 * replaces it: the very next LLM call, even mid-turn, carries the update.
	 */
	const emitModelStatus = (ctx: ExtensionContext, sessionModel = ctx.model) => {
		const available = ctx.modelRegistry.getAvailable();
		const configured = applicableSubagentDefault(loadSubagentDefault(os.homedir()), sessionModel);
		const resolution = resolveSubagentModel({ configuredDefault: configured, sessionModel, available });
		for (const notice of resolution.notices) notifyModelOnce(ctx, notice);
		pi.events.emit(REMINDER_CHANNEL, {
			text: subagentModelsReminder({
				available,
				sessionModel,
				defaultModel: resolution.model,
				defaultSource: resolution.source,
				configured,
			}),
			scope: "every-turn",
			key: "subagent-models",
			placement: "first-prepend",
			order: CONTEXT_ORDER.subagentModels,
		});
		pi.events.emit(SUBAGENT_STATUS_CHANNEL, subagentStatusModel(configured, resolution));
	};

	/**
	 * The agent catalog as an every-turn reminder, as Claude Code does ("Available
	 * agent types are listed in <system-reminder> messages") — without it the
	 * model has to guess names or make a discovery call first. Keyed and
	 * byte-stable within a session, so it costs nothing in prompt-cache terms.
	 */
	const emitAgentCatalog = (ctx: ExtensionContext) => {
		pi.events.emit(REMINDER_CHANNEL, {
			scope: "every-turn",
			key: "subagent-agents",
			text: `Available agents for the Agent tool (\`subagent_type\` field):\n${describeAgents(ctx.cwd)}`,
			placement: "first-prepend",
			order: CONTEXT_ORDER.agents,
		});
	};

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		reconstructRuns(ctx);
		emitModelStatus(ctx);
		emitAgentCatalog(ctx);
		registerPanelInputHook(ctx);
	});
	pi.on("model_select", (event, ctx) => emitModelStatus(ctx, event.model));
	pi.on("session_tree", (_event, ctx) => reconstructRuns(ctx));
	pi.on("session_shutdown", () => {
		stopAllAgents();
		panel.dispose();
	});

	// --- The subagent panel: strip soft focus + Enter-to-view transcript swap ---

	/** Stop one live agent by task id (foreground handle or background task). */
	const stopAgent = (taskId: string) => liveHandles.get(taskId)?.kill();
	const stopAllAgents = () => {
		for (const [, handle] of liveHandles) handle.kill();
	};

	/**
	 * Markdown prose for the transcript views — pi-tui's real renderer, loaded
	 * lazily on first view; falls back to plain wrapped text with one warning.
	 */
	let prosePromise: Promise<ProseRenderer | undefined> | undefined;
	const getProse = (ctx: ExtensionContext): Promise<ProseRenderer | undefined> =>
		(prosePromise ??= createMarkdownProse().catch((error) => {
			try {
				ctx.ui.notify(`Subagent viewer: markdown rendering unavailable (${(error as Error).message}) — using plain text.`, "warning");
			} catch {
				// no UI — plain text is fine
			}
			return undefined;
		}));

	/**
	 * Liveness for the transcript view: change-driven repaints (one registry
	 * event per provider delta, coalesced to ~80ms) plus a 1s ticker for elapsed
	 * time. `relevant` filters by the event's taskId so unrelated concurrent
	 * children's deltas don't invalidate the view's cache.
	 */
	const liveRepaint = (tui: { requestRender(): void }, invalidate: () => void, relevant: (taskId?: string) => boolean = () => true) => {
		let coalesce: ReturnType<typeof setTimeout> | undefined;
		const repaint = () => {
			invalidate();
			tui.requestRender();
		};
		const unsubscribe = liveRuns.subscribe((taskId) => {
			if (!relevant(taskId) || coalesce) return;
			coalesce = setTimeout(() => {
				coalesce = undefined;
				repaint();
			}, 80);
			coalesce.unref?.();
		});
		const ticker = setInterval(repaint, 1000);
		ticker.unref?.();
		return {
			repaint,
			cleanup: () => {
				clearInterval(ticker);
				if (coalesce) clearTimeout(coalesce);
				unsubscribe();
			},
		};
	};

	/**
	 * Claude Code's agent view: arrows only move the strip selection — Enter
	 * swaps the transcript region to the selected child (a non-capturing
	 * full-width overlay composited over the main transcript; the editor keeps
	 * focus, strip keys keep working). Enter on another row switches the view;
	 * Enter on `main`, esc, or typing closes it and the main transcript is back.
	 */
	let view: { retarget(taskId: string): void; scrollBy(delta: number): void; close(): void } | undefined;
	/** Rows kept clear at the bottom: token counter + editor(3) + mode line + strip hint + strip rows + cwd/status(2) + one spare. */
	const viewReserve = () => panel.rowCount() + 9;

	const openView = (ctx: ExtensionContext, taskId: string) => {
		if (view) return view.retarget(taskId);
		let currentId = taskId;
		let scroll = 0;
		let maxScroll = 0;
		let closed = false;
		let repaintFn: (() => void) | undefined;
		let doneFn: ((result: null) => void) | undefined;
		const entry = {
			retarget(id: string) {
				if (currentId === id) return;
				currentId = id;
				scroll = 0;
				repaintFn?.();
			},
			scrollBy(delta: number) {
				scroll = Math.max(0, Math.min(maxScroll, scroll + delta));
				repaintFn?.();
			},
			close() {
				if (closed) return;
				closed = true;
				if (view === entry) view = undefined;
				doneFn?.(null);
			},
		};
		view = entry;
		void (async () => {
			const prose = await getProse(ctx);
			if (closed) return;
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) => {
					doneFn = done;
					// close() raced ahead of the factory — dissolve as soon as we exist.
					if (closed) queueMicrotask(() => done(null));
					const paint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme) };
					let cache: { width: number; lines: string[] } | undefined;
					const live = liveRepaint(
						tui,
						() => {
							cache = undefined;
						},
						(taskId) => taskId === undefined || taskId === currentId,
					);
					repaintFn = live.repaint;
					const height = () => Math.max(8, tui.terminal.rows - viewReserve());
					return {
						render: (width: number) => {
							if (cache?.width === width) return cache.lines;
							const run = liveRuns.get(currentId);
							let lines: string[];
							if (run) {
								const transcript = renderTranscript({ run, width, height: height(), scroll, now: Date.now(), prose }, paint);
								maxScroll = transcript.maxScroll;
								lines = transcript.lines;
							} else {
								lines = [paint.fg("dim", "agent gone")];
							}
							cache = { width, lines: lines.map((line) => truncateLine(line, width)) };
							return cache.lines;
						},
						invalidate: () => {
							cache = undefined;
						},
						dispose: () => live.cleanup(),
					};
				},
				{ overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", nonCapturing: true } },
			);
		})().catch(() => {
			if (view === entry) view = undefined;
		});
	};
	const closeView = () => view?.close();

	let panelHookRegistered = false;
	const registerPanelInputHook = (registerCtx: ExtensionContext) => {
		if (panelHookRegistered || !registerCtx.hasUI) return;
		panelHookRegistered = true;
		let chordArmed = false;
		const leave = () => {
			panel.setFocus(undefined);
			closeView();
		};
		const DOWN_KEYS = new Set(["\x1b[B", "\x1bOB"]);
		try {
			registerCtx.ui.onTerminalInput((data) => {
				const ctx = lastCtx ?? registerCtx;
				// Enter focus: down-arrow while the editor holds real focus. Unlike the
				// workflow strip we do NOT require the editor to be idle — the whole
				// point is inspecting agents that run while the main turn is in flight.
				// This branch is the per-keystroke hot path — the O(rows) rowCount()
				// runs only once a Down actually asks to focus, never on plain typing.
				if (panel.focusIndex === undefined) {
					if (!DOWN_KEYS.has(data) || !panel.editorFocused()) return undefined;
					if (panel.rowCount() <= 1) return undefined;
					panel.setFocus(0);
					return { consume: true };
				}
				// The strip emptied under us (finished rows lingered out) — let go.
				if (panel.rowCount() <= 1) {
					leave();
					return undefined;
				}
				// Focus moved to a dialog/overlay — drop soft focus, let it have the key.
				if (!panel.editorFocused()) {
					leave();
					return undefined;
				}
				const decoded = decodeStripKey(data, chordArmed);
				chordArmed = decoded.chordArmed;
				if (!decoded.key) {
					if (chordArmed) return { consume: true }; // ctrl+x armed the stop-all chord
					leave();
					return undefined; // typing resumes in the editor, byte included
				}
				switch (decoded.key) {
					case "up":
						if (panel.focusIndex === 0) leave();
						else panel.setFocus(panel.focusIndex - 1);
						return { consume: true };
					case "down":
						panel.setFocus(Math.min(panel.rowCount() - 1, panel.focusIndex + 1));
						return { consume: true };
					case "leave":
						leave();
						// While the model streams, esc must still interrupt it — consume only when idle.
						return ctx.isIdle() ? { consume: true } : undefined;
					case "open": {
						// Claude Code's model: Enter swaps the view to the selection (and
						// switches an open view); Enter on `main` restores the main
						// transcript. Focus stays in the strip for the next switch.
						const run = panel.selectedRun();
						if (run) openView(ctx, run.taskId);
						else closeView();
						return { consume: true };
					}
					case "stop": {
						const run = panel.selectedRun();
						if (run) stopAgent(run.taskId);
						return { consume: true };
					}
					case "stopAll":
						stopAllAgents();
						return { consume: true };
					case "pageUp":
						view?.scrollBy(10);
						return { consume: true };
					case "pageDown":
						view?.scrollBy(-10);
						return { consume: true };
				}
			});
		} catch {
			// Mode without raw terminal input (print/RPC) — the strip is view-only.
		}
	};

	// Compact transcript rendering for the notifications this extension injects
	// (full body on ctrl+o); the verbose framing stays model-only.
	for (const customType of ["subagent-message", "subagent-result"]) {
		pi.registerMessageRenderer(customType, (message, { expanded }, theme) =>
			notificationComponent(theme, customMessageText(message.content), expanded),
		);
	}

	const notify = (customType: string, text: string, details: Record<string, unknown>) => {
		pi.sendMessage(
			{ customType, content: [{ type: "text", text }], display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	/** Relay a child's send_message {to: "main"} into this conversation. */
	const notifyAgentMessage = (name: string, message: string, summary?: string) =>
		notify(
			"subagent-message",
			systemNotification(`Message from agent ${name}${summary ? ` (${summary})` : ""}:\n\n${message}`),
			{ name, summary },
		);

	/** Session dir for a run's persisted child session; undefined → child runs --no-session. */
	const runSessionDir = (ctx: ExtensionContext, taskId: string): string | undefined => {
		try {
			const dir = join(ctx.sessionManager.getSessionDir(), "subagents", taskId);
			mkdirSync(dir, { recursive: true });
			return dir;
		} catch {
			return undefined;
		}
	};

	interface PreparedRun {
		request: RunRequest;
		record: AgentRunRecord;
		agentDef?: AgentDefinition;
	}

	/**
	 * How deep Agent-in-Agent nesting goes: a run at depth < MAX_SPAWN_DEPTH
	 * gets the spawn tool, so main(–) → child(0) → grandchild(1) and no further.
	 * Matches CC (its subagents/forks spawn their own agents) while bounding
	 * runaway fan-out — every session shares one in-process event loop.
	 */
	const MAX_SPAWN_DEPTH = 1;

	/**
	 * Catalog text for the injected spawn tool, cached per cwd: building a
	 * child's toolset must not re-scan the agent dirs on every spawn — a wide
	 * fan-out would pay the filesystem walk N times for a description most
	 * children never use. Fork is not listed (unavailable inside a child).
	 * Validation in execute() still loads fresh; only this string is pinned,
	 * which is what tool descriptions are anyway — static for the session.
	 */
	const childCatalogCache = new Map<string, string>();
	const childCatalog = (cwd: string): string => {
		let text = childCatalogCache.get(cwd);
		if (text === undefined) {
			text = loadAgents(cwd)
				.map((a) => `- ${a.name}: ${a.description || "(no description)"}`)
				.join("\n");
			childCatalogCache.set(cwd, text);
		}
		return text;
	};

	/**
	 * The Agent tool injected into a child session (CC parity: subagents can
	 * spawn subagents). It delegates to THIS extension's runtime and registries,
	 * so a nested run streams into the same panel (as a `└` row under its
	 * parent), is gated through the parent's real permission pipeline, and is
	 * addressable by SendMessage like any other run. Foreground-only: the call
	 * returns when the nested agent finishes — no fork, worktree, or background
	 * from inside a child.
	 */
	const childAgentTool = (parentRecord: AgentRunRecord, parentDepth: number): ToolDefinition =>
		({
			name: "Agent",
			label: "Agent",
			description:
				"Delegate a scoped task to a specialist subagent running in its own context window. The call BLOCKS until the agent finishes and returns its report — use it for well-scoped work whose intermediate output you don't need (broad searches, focused verification, independent research). Give a complete, self-contained task: the agent cannot ask follow-ups. Available agents:\n" +
				`${childCatalog(parentRecord.cwd)}\n` +
				'(No "fork" here — forking is only available to the main conversation.)',
			parameters: Type.Object({
				subagent_type: Type.String({ description: "An agent name from the list in this tool's description" }),
				task: Type.String({ description: "The task — a complete, self-contained instruction" }),
				name: Type.Optional(Type.String({ description: "Name for this run (default: <agent>-<n>)" })),
			}) as never,
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
				const ctx = lastCtx;
				const p = (params ?? {}) as { subagent_type?: unknown; task?: unknown; name?: unknown };
				const agentName = typeof p.subagent_type === "string" ? p.subagent_type : "";
				const task = typeof p.task === "string" ? p.task.trim() : "";
				const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
				if (!ctx) return err("The host session is not ready to spawn agents — retry shortly.");
				if (agentName === FORK_AGENT) return err('"fork" is only available to the main conversation — pick a named agent instead.');
				const agents = loadAgents(ctx.cwd);
				const agentDef = agents.find((a) => a.name === agentName);
				if (!agentDef) {
					const catalog = agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n");
					return err(`${agentName ? `Unknown agent "${agentName}"` : "`subagent_type` is required"}. Available agents:\n${catalog}`);
				}
				if (!task) return err("`task` is required: a complete, self-contained instruction for the agent.");

				const taken = new Set(registry.names());
				const requestedName = typeof p.name === "string" ? p.name.trim() : "";
				const name = requestedName && !taken.has(requestedName) ? requestedName : nextRunName(taken, agentName);
				// Same parent-side model resolution as the main Agent tool, minus
				// per-call overrides: the agent's own model, else the configured
				// default, else the session model.
				const available = ctx.modelRegistry.getAvailable();
				const resolution = resolveSubagentModel({
					agentModel: agentDef.model,
					configuredDefault: applicableSubagentDefault(loadSubagentDefault(os.homedir()), ctx.model),
					sessionModel: ctx.model,
					available,
				});
				for (const notice of resolution.notices) notifyModelOnce(ctx, notice);
				const resolved = resolution.model ? modelSpec(resolution.model) : undefined;

				const taskId = generateTaskId();
				const record: AgentRunRecord = {
					name,
					agent: agentName,
					taskId,
					sessionSearchDir: runSessionDir(ctx, taskId) ?? "",
					cwd: ctx.cwd,
					model: resolved,
					thinking: undefined,
					depth: parentDepth + 1,
				};
				registry.add(record); // SendMessage from main can reach the nested run too

				const result = await executeRun(
					{
						request: {
							agent: agentName,
							task,
							name,
							model: resolved,
							fallbackModel: spawnFallbackModel(resolved, resolution.source, ctx.model),
						},
						record,
						agentDef,
					},
					ctx,
					undefined,
					signal, // the spawning child aborting (stop/esc) kills the nested run
					() => {},
					undefined,
					{ taskId: parentRecord.taskId, depth: parentDepth },
				);
				return {
					content: [{ type: "text" as const, text: `${result.output}\n\n(${formatStats(result.toolCalls, result.usage)})` }],
					details: { agentRuns: [record] },
					isError: result.failed ?? false,
				};
			},
		}) as ToolDefinition;

	/**
	 * The spawn tool a run is entitled to. THE one depth gate: it reads the
	 * record's own depth (set once at creation), so every handout site —
	 * fresh spawn, background resident, SendMessage resume — enforces
	 * MAX_SPAWN_DEPTH identically. A resumed grandchild stays capped.
	 */
	const spawnToolsFor = (record: AgentRunRecord): ToolDefinition[] => {
		const depth = record.depth ?? 0;
		return depth < MAX_SPAWN_DEPTH ? [childAgentTool(record, depth)] : [];
	};

	/**
	 * Start one child (creating a worktree first if asked) and finalize its
	 * record when done. `parent` marks a NESTED spawn — a child's own Agent
	 * call — which links the run under its parent in the panel tree.
	 */
	const executeRun = async (
		prepared: PreparedRun,
		ctx: ExtensionContext,
		forkFrom: string | undefined,
		signal: AbortSignal | undefined,
		onProgress: (toolCalls: number, text: string, usage: UsageTotals) => void,
		onStarted?: (handle: ChildHandle, worktree?: Worktree) => void,
		parent?: { taskId: string; depth: number },
	): Promise<TaskResult> => {
		const { request, record, agentDef } = prepared;

		let worktree: Worktree | undefined;
		if (request.worktree) {
			try {
				worktree = await createWorktree(ctx.cwd, request.name);
				record.cwd = worktree.path;
			} catch (error) {
				return {
					agent: request.agent,
					name: request.name,
					taskId: record.taskId,
					task: request.task,
					output: `Could not create a worktree: ${(error as Error).message}`,
					toolCalls: 0,
					usage: emptyUsage(),
					failed: true,
				};
			}
		}

		runningNames.add(request.name);
		const live = trackLiveRun(record, request, parent);
		const runtime = await getRuntime(ctx);
		const handle = runtime.run({
			agent: agentDef,
			task: request.task,
			cwd: record.cwd,
			forkFrom: request.fork ? forkFrom : undefined,
			parentSystemPrompt: request.fork ? ctx.getSystemPrompt() : undefined,
			sessionDir: record.sessionSearchDir || undefined,
			model: request.model,
			fallbackModel: request.fallbackModel,
			thinking: request.thinking,
			signal,
			onProgress: (toolCalls, text, usage) => {
				live.progress(toolCalls, usage);
				onProgress(toolCalls, text, usage);
			},
			sink: live.sink,
			onMessageToMain: (message, summary) => notifyAgentMessage(request.name, message, summary),
			extraTools: spawnToolsFor(record),
		});
		liveHandles.set(record.taskId, handle);
		onStarted?.(handle, worktree);

		try {
			const outcome: ChildOutcome = await handle.result;
			registry.sessionFileFor(record); // resolve now that the child has written it
			live.finish(Boolean(outcome.failed));
			let worktreeKept: boolean | undefined;
			if (worktree) {
				worktreeKept = !(await cleanupWorktree(ctx.cwd, worktree));
			}
			return {
				agent: request.agent,
				name: request.name,
				taskId: record.taskId,
				task: request.task,
				...outcome,
				worktreePath: worktreeKept ? worktree?.path : undefined,
				worktreeKept,
			};
		} catch (error) {
			live.finish(true);
			if (worktree) await cleanupWorktree(ctx.cwd, worktree);
			return {
				agent: request.agent,
				name: request.name,
				taskId: record.taskId,
				task: request.task,
				output: `Subagent failed: ${(error as Error).message}`,
				toolCalls: 0,
				usage: emptyUsage(),
				failed: true,
			};
		} finally {
			runningNames.delete(request.name);
		}
	};

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		...ccToolRenderers<{ subagent_type?: string; task?: string; action?: string }>("Agent", {
			title: (a) => (a ? [a.subagent_type, a.task ?? a.action].filter(Boolean).join(": ") || undefined : undefined),
		}),
		description:
			"Delegate a task to a specialist agent that runs in its own context window and reports back. Use it for well-scoped work whose intermediate output you don't need — broad codebase searches, focused reviews, independent research. Give a complete, self-contained task: the agent cannot ask follow-up questions. The available agents are listed in the \"Available agents\" system reminder. Use `subagent_type: \"fork\"` for a child that inherits this conversation (a fork always runs on this conversation's model and reasoning settings; if you are the fork, execute your assigned task directly — don't re-delegate), `isolation: \"worktree\"` when the agent will edit files, or `run_in_background: true` to keep working while it runs (completion arrives as a notification; manage with task_output/task_stop). To run several agents in parallel, issue multiple Agent calls in one turn. Each run gets a name — continue a finished agent later with SendMessage. action:'list' re-prints the agent catalog. Delegating means you keep the conclusion, not the file dumps — but for a single-fact lookup you already know how to run, search directly. Once you've delegated work, don't also run it yourself; wait for the result, and never fabricate or predict a pending agent's output — if asked before it arrives, say it's still running. The agent's final report isn't shown to the user, so relay what matters.",
		promptSnippet: "Delegate scoped work to a specialist agent in its own context",
		parameters: SubagentParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(ctx.cwd);

			// A call carrying run options (a task, a name, run_in_background, a
			// model/thinking/isolation override, or action:"run") but no `subagent_type`
			// is a run that forgot to name its agent. Fail loudly with a diagnostic
			// rather than silently returning the catalog: a weaker model reads the
			// catalog as a non-sequitur and invents wrong reasons for it, instead of
			// learning it omitted `subagent_type`.
			const wantsRun =
				params.action === "run" ||
				params.task != null ||
				params.name != null ||
				params.run_in_background != null ||
				params.model != null ||
				params.isolation != null ||
				params.thinking != null;

			if (params.action === "list" || (!params.subagent_type && !wantsRun)) {
				return {
					content: [{ type: "text", text: `Available agents:\n${describeAgents(ctx.cwd)}` }],
					details: { agents: agents.map((a) => a.name) },
				};
			}

			if (!params.subagent_type) {
				return {
					content: [
						{
							type: "text",
							text: `No \`subagent_type\` given, but you passed run options — this looks like a run that forgot to name its agent. Set \`subagent_type\` to one of the names below (or "fork" to clone this conversation). To only browse the catalog, call with action:"list".\n\nAvailable agents:\n${describeAgents(ctx.cwd)}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const taken = new Set(registry.names());
			const requested: RunRequest[] = [{ agent: params.subagent_type, task: params.task ?? "", name: params.name }].map((entry) => {
				const name = entry.name || nextRunName(taken, entry.agent);
				taken.add(name);
				return {
					agent: entry.agent,
					task: entry.task,
					name,
					fork: entry.agent === FORK_AGENT,
					model: params.model,
					thinking: params.thinking,
					worktree: params.isolation === "worktree",
				};
			});

			// A fork continues this conversation; running it on a different model or
			// reasoning effort is how the fork-confabulation incident happened (a
			// minimal-thinking fork resumed the inherited topic instead of its task).
			// Claude Code silently ignores `model` for forks; we fail loud instead.
			if (requested.some((r) => r.fork) && (params.model || params.thinking)) {
				return {
					content: [
						{
							type: "text",
							text: '`model`/`thinking` overrides are not applied to fork runs — a fork continues this conversation and keeps its exact model and reasoning settings. Drop the override, or use a named agent (e.g. "general-purpose") to run the task with different settings.',
						},
					],
					details: {},
					isError: true,
				};
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (requested.some((r) => r.fork) && !sessionFile) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot fork: this session is not persisted (started with --no-session), so there is no transcript to clone. Use a named agent instead.",
						},
					],
					details: {},
					isError: true,
				};
			}

			const unknown = requested.filter((r) => !r.fork && !agents.some((a) => a.name === r.agent));
			if (unknown.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent(s): ${unknown.map((u) => u.agent).join(", ")}\n\nAvailable agents:\n${describeAgents(ctx.cwd)}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			if (requested.some((r) => r.worktree) && !(await isGitRepo(ctx.cwd))) {
				return {
					content: [{ type: "text", text: 'isolation: "worktree" needs a git repository; this directory is not one.' }],
					details: {},
					isError: true,
				};
			}

			const prepared: PreparedRun[] = requested.map((request) => {
				const taskId = generateTaskId();
				return {
					request,
					agentDef: request.fork ? undefined : agents.find((a) => a.name === request.agent),
					record: {
						name: request.name,
						agent: request.agent,
						taskId,
						sessionSearchDir: runSessionDir(ctx, taskId) ?? "",
						cwd: ctx.cwd,
						model: request.model,
						thinking: request.thinking,
						depth: 0,
					},
				};
			});

			/**
			 * Model resolution happens here, in the parent, against the real
			 * registry — never in the child, whose `--model` fuzzy-matches across
			 * every configured provider. The child is spawned with a concrete
			 * `provider/id`; anything surprising (a fallback, a provider crossing)
			 * is said out loud rather than happening silently.
			 */
			const available = ctx.modelRegistry.getAvailable();
			const configuredDefault = applicableSubagentDefault(loadSubagentDefault(os.homedir()), ctx.model);
			for (const p of prepared) {
				// A fork inherits the parent transcript, so it must continue on THIS
				// conversation's exact model — never a configured default or the
				// automatic same-provider pick, which would move the inherited context
				// onto a different (often weaker) model. Leaving model undefined makes
				// the forked session restore its own model. (Per-call `model` on a fork
				// is already rejected above.)
				if (p.request.fork) continue;
				const resolution = resolveSubagentModel({
					requested: p.request.model,
					agentModel: p.agentDef?.model,
					configuredDefault: configuredDefault,
					sessionModel: ctx.model,
					available,
				});
				if (resolution.unresolved) {
					// The main model chose this string; the menu lets it retry.
					const fallback = resolveSubagentModel({
						configuredDefault: configuredDefault,
						sessionModel: ctx.model,
						available,
					});
					return {
						content: [
							{
								type: "text",
								text:
									`Unknown model "${resolution.unresolved}" — no available model matches it.\n\n` +
									subagentModelsReminder({
										available,
										sessionModel: ctx.model,
										defaultModel: fallback.model,
										defaultSource: fallback.source,
									}),
							},
						],
						details: {},
						isError: true,
					};
				}
				const gate = expensiveModelGate(resolution, ctx.model, params.allow_expensive);
				if (gate) {
					const fallback = resolveSubagentModel({
						configuredDefault: configuredDefault,
						sessionModel: ctx.model,
						available,
					});
					return {
						content: [
							{
								type: "text",
								text:
									`${gate}\n` +
									"If the user explicitly asked for this model, retry with allow_expensive: true; " +
									"otherwise pick a cheaper model or omit the field.\n\n" +
									subagentModelsReminder({
										available,
										sessionModel: ctx.model,
										defaultModel: fallback.model,
										defaultSource: fallback.source,
									}),
							},
						],
						details: {},
						isError: true,
					};
				}
				for (const notice of resolution.notices) notifyModelOnce(ctx, notice);
				const resolved = resolution.model ? modelSpec(resolution.model) : undefined;
				p.request.model = resolved;
				p.request.fallbackModel = spawnFallbackModel(resolved, resolution.source, ctx.model);
				p.record.model = resolved;
			}

			for (const p of prepared) registry.add(p.record);
			const records = prepared.map((p) => p.record);

			// --- Background: RPC children that stay resident after their run, so
			// send_message can reach them live (steer mid-turn, prompt when idle).
			if (params.run_in_background) {
				const lines: string[] = [];
				const runtime = await getRuntime(ctx);
				for (const p of prepared) {
					let worktree: Worktree | undefined;
					if (p.request.worktree) {
						try {
							worktree = await createWorktree(ctx.cwd, p.request.name);
							p.record.cwd = worktree.path;
						} catch (error) {
							lines.push(`✗ ${p.record.name}: could not create a worktree: ${(error as Error).message}`);
							continue;
						}
					}

					const logPath = p.record.sessionSearchDir ? join(p.record.sessionSearchDir, "output.log") : undefined;
					let finish!: () => void;
					const finished = new Promise<void>((resolve) => {
						finish = resolve;
					});

					// The child's final output. task.output() falls back to this
					// because handle.snapshot().text can be blank at a turn boundary —
					// the same reason the log write below uses `|| outcome.output`.
					// Keeps task_output consistent with the log and the completion
					// notification rather than showing an empty body in that case.
					let lastOutput = "";
					const live = trackLiveRun(p.record, p.request);
					const resident: Resident = { handle: undefined as never, turnHandlers: [] };
					const worktreeNote = worktree
						? `\n\n(Running in worktree ${worktree.path} — kept while the agent stays resident.)`
						: "";
					resident.turnHandlers.push((outcome) => {
						task.status = outcome.failed ? "failed" : "completed";
						task.finishedAt = Date.now();
						finish();
						const stats = formatStats(outcome.toolCalls, outcome.usage);
						notify(
							"subagent-result",
							systemNotification(`Background agent ${p.record.name} (${p.record.taskId}) ${outcome.failed ? "failed" : "completed"} (${stats}). It stays resident — message it with send_message.\n\n${outcome.output.slice(0, OUTPUT_CAP)}${worktreeNote}`),
							{ taskId: p.record.taskId, name: p.record.name, failed: outcome.failed ?? false },
						);
					});

					const handle = await runtime.runResident({
						agent: p.agentDef,
						cwd: p.record.cwd,
						forkFrom: p.request.fork ? (sessionFile ?? undefined) : undefined,
						parentSystemPrompt: p.request.fork ? ctx.getSystemPrompt() : undefined,
						sessionDir: p.record.sessionSearchDir || undefined,
						model: p.request.model,
						fallbackModel: p.request.fallbackModel,
						thinking: p.request.thinking,
						onProgress: (toolCalls, text, usage) => {
							live.progress(toolCalls, usage);
							if (logPath && text) writeFileSync(logPath, text);
						},
						sink: live.sink,
						onMessageToMain: (message, summary) => notifyAgentMessage(p.record.name, message, summary),
						extraTools: spawnToolsFor(p.record),
						onTurnEnd: (outcome) => {
							registry.sessionFileFor(p.record);
							live.settle();
							lastOutput = resident.handle.snapshot().text || outcome.output;
							if (logPath) writeFileSync(logPath, lastOutput);
							// Auto mode reviews a background/resident turn's action sequence as a
							// whole, like the foreground path (line ~758). There is no tool_result
							// to attach to here, so the gate reviews on receipt and notifies.
							if (outcome.actions?.length) {
								pi.events.emit(SUBAGENT_ACTIONS_CHANNEL, {
									toolCallId: p.record.taskId,
									actions: outcome.actions,
									background: true,
									agentName: p.record.name,
								} satisfies SubagentActionsPayload);
							}
							const handler = resident.turnHandlers.shift();
							if (handler) {
								handler(outcome);
							} else {
								// A turn nobody is waiting on (e.g. a steer that raced past its
								// target turn and ran on its own) must still surface.
								notify(
									"subagent-result",
									systemNotification(`Update from ${p.record.name}:\n\n${outcome.output.slice(0, OUTPUT_CAP)}`),
									{ name: p.record.name, failed: outcome.failed ?? false },
								);
							}
						},
						onExit: () => {
							live.finish(false);
							if (residents.get(p.record.name) === resident) residents.delete(p.record.name);
							if (worktree) void cleanupWorktree(ctx.cwd, worktree);
						},
					});
					resident.handle = handle;
					residents.set(p.record.name, resident);
					liveHandles.set(p.record.taskId, handle);

					const task: BackgroundTask = {
						id: p.record.taskId,
						kind: "subagent",
						description: `${p.record.name}: ${p.request.task.slice(0, 80)}`,
						status: "running",
						startedAt: Date.now(),
						logPath,
						output: () => handle.snapshot().text || lastOutput,
						stop: () => handle.kill(),
						resident: () => !handle.exited(),
						finished,
					};
					pi.events.emit(TASK_REGISTER_CHANNEL, task);
					handle.send(p.request.fork ? forkTaskMessage(p.request.task) : p.request.task);

					lines.push(
						`⏳ ${p.record.name} (task ${p.record.taskId}) running in background${logPath ? ` — interim output readable at ${logPath}` : ""}`,
					);
				}
				return {
					content: [
						{
							type: "text",
							text: `${lines.join("\n")}\n\nCompletion (with the agent's report) will arrive as a system notification on its own — you do not need to wait for it or poll; keep working. Call task_output only if your next step cannot proceed without the result (block=true waits). Stop with task_stop; send_message reaches the agent even while it runs (the message is steered into its current turn).`,
						},
					],
					details: { agentRuns: records, background: true },
				};
			}

			// --- Foreground: live progress, blocking result (one run per call).
			const prep = prepared[0];
			let progress = { toolCalls: 0, text: "", usage: emptyUsage() };
			const report = () => {
				const stats = formatStats(progress.toolCalls, progress.usage);
				const line = `${progress.text ? "✓" : "⏳"} ${prep.request.name} (${stats})${progress.text ? "" : " running…"}`;
				onUpdate?.({ content: [{ type: "text", text: line }], details: {} });
			};
			report();

			const result = await executeRun(prep, ctx, sessionFile ?? undefined, signal, (toolCalls, text, usage) => {
				progress = { toolCalls, text, usage };
				report();
			});

			const stats = formatStats(result.toolCalls, result.usage);
			const worktreeNote = result.worktreePath ? `\n\n(Changes left in worktree ${result.worktreePath} — review or merge them.)` : "";
			const text = `${result.output}${worktreeNote}\n\n(${stats})`;

			// Auto mode reviews what a child actually did once it returns, catching a
			// sequence whose individual steps each passed. Emitted rather than
			// checked here: the permission gate owns the classifier.
			pi.events.emit(SUBAGENT_ACTIONS_CHANNEL, {
				toolCallId,
				actions: result.actions ?? [],
			} satisfies SubagentActionsPayload);

			return {
				content: [{ type: "text", text }],
				details: { results: [result], agentRuns: records },
				isError: result.failed ?? false,
			};
		},
	});

	pi.registerTool({
		name: "SendMessage",
		label: "Send Message",
		...ccToolRenderers<{ to?: string; summary?: string; message?: string }>("Send Message", {
			title: (a) => (a?.to ? `to ${a.to}${a.summary ? `: ${a.summary}` : ""}` : undefined),
		}),
		description:
			'Send a message to a previously spawned agent, addressed by the name from its spawn result (or its task id). A resident background agent is reached live (mid-turn the message is steered into its current work; when idle it starts a new turn); a finished agent is resumed from its session with full context. Replies arrive as system notifications. (A subagent reporting back to the main conversation uses its own SendMessage with to: "main".)',
		parameters: Type.Object({
			to: Type.String({ description: "Agent name (or task id) from a previous Agent run" }),
			message: Type.String({ description: "Plain text message for the agent" }),
			summary: Type.Optional(Type.String({ description: "5-10 word preview shown in the UI" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.to === "main") {
				// The main conversation's SendMessage only addresses spawned agents; the
				// "main" recipient exists only on a subagent's own injected SendMessage.
				return {
					content: [{ type: "text", text: 'You are the main conversation — "main" is only a valid recipient from inside a subagent.' }],
					details: {},
					isError: true,
				};
			}

			const record = registry.resolve(params.to);
			if (!record) {
				const known = registry.names().join(", ") || "(none)";
				return {
					content: [
						{
							type: "text",
							text: `No run named "${params.to}". SendMessage only reaches agent runs already started this session — address them by their run name or task id, not by a catalog agent name. Start one with the Agent tool first if you haven't. Known runs: ${known}.`,
						},
					],
					details: {},
					isError: true,
				};
			}
			// Resident background agent: reach it live over its RPC channel.
			const resident = residents.get(record.name);
			if (resident && !resident.handle.exited()) {
				if (resident.handle.busy()) {
					resident.handle.send(params.message);
					return {
						content: [
							{
								type: "text",
								text: `Message steered into ${record.name}'s running turn — it will be taken into account before the turn completes, and the turn's completion notification will reflect it.`,
							},
						],
						details: { agentRuns: [record], steered: true },
					};
				}

				const taskId = generateTaskId();
				let finish!: () => void;
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				// This task is ONE turn of the resident agent. Its output must be that
				// turn's reply — the same text the reply notification carries — not the
				// resident's whole multi-turn transcript, or task_output and the
				// notification disagree (superset), which weak models conflate.
				let replyOutput = "";
				const task: BackgroundTask = {
					id: taskId,
					kind: "subagent",
					description: `message to ${record.name}${params.summary ? `: ${params.summary}` : ""}`,
					status: "running",
					startedAt: Date.now(),
					output: () => replyOutput || resident.handle.snapshot().text,
					stop: () => resident.handle.kill(),
					resident: () => !resident.handle.exited(),
					finished,
				};
				resident.turnHandlers.push((outcome) => {
					task.status = outcome.failed ? "failed" : "completed";
					task.finishedAt = Date.now();
					replyOutput = outcome.output;
					finish();
					const stats = formatStats(outcome.toolCalls, outcome.usage);
					notify(
						"subagent-result",
						systemNotification(`Reply from ${record.name} (${stats}):\n\n${outcome.output.slice(0, OUTPUT_CAP)}`),
						{ taskId, name: record.name, failed: outcome.failed ?? false },
					);
				});
				pi.events.emit(TASK_REGISTER_CHANNEL, task);
				resident.handle.send(params.message);
				return {
					content: [
						{
							type: "text",
							text: `Message sent to resident agent ${record.name} (task ${taskId}). The reply will arrive as a system notification; inspect with task_output.`,
						},
					],
					details: { agentRuns: [record], taskId },
				};
			}

			if (runningNames.has(record.name)) {
				return {
					content: [
						{ type: "text", text: `Agent ${record.name} is still running — wait for its completion notification, then resend.` },
					],
					details: {},
					isError: true,
				};
			}
			const sessionFile = registry.sessionFileFor(record);
			if (!sessionFile) {
				return {
					content: [
						{ type: "text", text: `Agent ${record.name} has no persisted session to resume (it may have run before session persistence, or its files were removed).` },
					],
					details: {},
					isError: true,
				};
			}

			const taskId = generateTaskId();
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});

			runningNames.add(record.name);
			// Re-enter the panel: the finished run's entry flips back to running (or
			// registers fresh after a session resume) and streams this turn live.
			const live = trackLiveRun(record, {
				agent: record.agent,
				name: record.name,
				task: params.message,
				model: record.model,
				thinking: record.thinking,
			});
			const runtime = await getRuntime(ctx);
			const handle = runtime.run({
				agent: loadAgents(ctx.cwd).find((a) => a.name === record.agent),
				task: params.message,
				cwd: record.cwd,
				sessionFile,
				model: record.model,
				// Resume degrades to the session model if the recorded model has become
				// unavailable since the original run, rather than failing the resume
				// outright (the note surfaces the swap). Undefined for a fork (record.model
				// unset — it inherits) or when the record already is the session model.
				fallbackModel:
					record.model && ctx.model && record.model !== modelSpec(ctx.model) ? modelSpec(ctx.model) : undefined,
				thinking: record.thinking,
				onProgress: (toolCalls, _text, usage) => live.progress(toolCalls, usage),
				sink: live.sink,
				onMessageToMain: (message, summary) => notifyAgentMessage(record.name, message, summary),
				extraTools: spawnToolsFor(record),
			});
			liveHandles.set(record.taskId, handle);

			const task: BackgroundTask = {
				id: taskId,
				kind: "subagent",
				description: `message to ${record.name}${params.summary ? `: ${params.summary}` : ""}`,
				status: "running",
				startedAt: Date.now(),
				output: () => handle.snapshot().text,
				stop: () => handle.kill(),
				finished,
			};
			pi.events.emit(TASK_REGISTER_CHANNEL, task);

			void handle.result.then((outcome) => {
				runningNames.delete(record.name);
				live.finish(Boolean(outcome.failed));
				task.status = outcome.failed ? "failed" : "completed";
				task.finishedAt = Date.now();
				finish();
				const stats = formatStats(outcome.toolCalls, outcome.usage);
				notify(
					"subagent-result",
					systemNotification(`Reply from ${record.name} (${stats}):\n\n${outcome.output.slice(0, OUTPUT_CAP)}`),
					{ taskId, name: record.name, failed: outcome.failed ?? false },
				);
			});

			return {
				content: [
					{
						type: "text",
						text: `Message sent to ${record.name} (task ${taskId}). The reply will arrive as a system notification; inspect with task_output.`,
					},
				],
				details: { agentRuns: [record], taskId },
			};
		},
	});
	pi.events.emit(DEFER_CHANNEL, { name: "SendMessage", keywords: ["message", "agent", "resume", "continue", "teammate"] });

	// Same precedence as SendMessage's own dispatch (a live resident is reachable
	// even while a foreground run of the same name is in flight): resident-live
	// first, then running, then a finished run resumable from its session.
	const agentStatus = (name: string) => {
		const resident = residents.get(name);
		if (resident && !resident.handle.exited()) return "resident (reachable live)";
		if (runningNames.has(name)) return "running";
		return "finished (resume with SendMessage)";
	};

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		...ccToolRenderers("List Agents"),
		description:
			"List the agents spawned in this session — their names, types, and current status — so you know which ones SendMessage can reach. `running` is executing now; `resident` is idle but reachable live; `finished` is resumable from its session. This lists running/spawned instances, not the agent catalog (use Agent action:'list' for that).",
		parameters: Type.Object({}),
		async execute() {
			const runs = registry.list();
			if (runs.length === 0) {
				return {
					content: [{ type: "text", text: "No agents have been spawned in this session yet. Start one with the Agent tool." }],
					details: { agents: [] as unknown[] },
				};
			}
			const agents = runs.map((r) => ({ name: r.name, agent: r.agent, taskId: r.taskId, status: agentStatus(r.name) }));
			const lines = agents.map((a) => `- ${a.name} [${a.agent}] — ${a.status} (task ${a.taskId})`);
			return {
				content: [{ type: "text", text: `Agents spawned this session:\n${lines.join("\n")}` }],
				details: { agents },
			};
		},
	});
	pi.events.emit(DEFER_CHANNEL, { name: "list_agents", keywords: ["agents", "list", "running", "spawned", "subagents", "who"] });

	pi.registerCommand("agents", {
		description: "Open the live subagent panel, or list available agents",
		handler: async (_args, ctx) => {
			// With live children, focus the strip on the newest and open its view
			// (Claude Code's agent panel); otherwise there is nothing running, so
			// list the catalog the way the tool's action:"list" does.
			if (ctx.hasUI && panel.rowCount() > 1) {
				panel.setFocus(1); // row 0 is `main`; 1 is the newest live child
				const run = panel.selectedRun();
				if (run) {
					openView(ctx, run.taskId);
					return;
				}
			}
			ctx.ui.notify(`Available agents:\n${describeAgents(ctx.cwd)}`, "info");
		},
	});

	const showSubagentModelStatus = (ctx: ExtensionContext) => {
		const configured = loadSubagentDefault(os.homedir());
		const applicable = applicableSubagentDefault(configured, ctx.model);
		const available = ctx.modelRegistry.getAvailable();
		const resolution = resolveSubagentModel({
			configuredDefault: applicable,
			sessionModel: ctx.model,
			available,
		});
		ctx.ui.notify(
			[
				configured
					? `subagentModel: ${configured.spec} (from the ${configured.source})` +
						(applicable ? "" : " — not applied: CLAUDE_CODE_SUBAGENT_MODEL is Claude Code's knob, and this session is not on a Claude model")
					: "subagentModel: (not set)",
				`effective: ${resolution.model ? `${resolution.model.provider}/${resolution.model.id}` : "none"} (${resolution.source})`,
				...(resolution.notices.length ? [resolution.notices.join("\n")] : []),
				"Set it with /subagent <provider/model-id|sonnet|opus|haiku|fable|inherit>, or clear with /subagent clear.",
			].join("\n"),
			"info",
		);
	};

	/**
	 * Persist a chosen subagent default. `inherit` is literal (session model,
	 * no auth needed); any other spec is validated against the registry and its
	 * auth checked before saving — a default with no credentials would fail
	 * every subagent spawn. The value is saved as the literal spec, so an alias
	 * like `sonnet` keeps per-session alias semantics (see model-select.ts).
	 */
	const applySubagentModelChoice = async (spec: string, ctx: ExtensionContext): Promise<void> => {
		if (spec === "inherit") {
			try {
				persistSubagentModel("inherit", os.homedir());
			} catch (error) {
				ctx.ui.notify("Could not save subagent model: " + (error as Error).message, "error");
				return;
			}
			emitModelStatus(ctx);
			ctx.ui.notify('Subagent default set to the session model ("inherit", saved to ~/.claude/settings.json).', "info");
			return;
		}

		const available = ctx.modelRegistry.getAvailable();
		const resolution = resolveSubagentModel({ requested: spec, sessionModel: ctx.model, available });
		if (resolution.unresolved) {
			const fallback = resolveSubagentModel({
				configuredDefault: applicableSubagentDefault(loadSubagentDefault(os.homedir()), ctx.model),
				sessionModel: ctx.model,
				available,
			});
			ctx.ui.notify(
				`No available model matches "${spec}".\n\n` +
					subagentModelsReminder({
						available,
						sessionModel: ctx.model,
						defaultModel: fallback.model,
						defaultSource: fallback.source,
					}),
				"error",
			);
			return;
		}
		const resolved = resolution.model;
		if (resolved) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved);
			if (!auth.ok) {
				ctx.ui.notify(`Cannot use ${resolved.provider}/${resolved.id}: ${auth.error}. Not saved.`, "error");
				return;
			}
		}
		try {
			// Stamp the session's containment identity (provider for direct vendors,
			// provider:route:vendor on gateways) so a later session on a different
			// provider/vendor can treat this cross-provider choice as stale (a
			// deliberate choice made here stays honored; see resolveSubagentModel).
			persistSubagentModel(spec, os.homedir(), ctx.model ? modelIdentity(ctx.model).containment : undefined);
		} catch (error) {
			ctx.ui.notify("Could not save subagent model: " + (error as Error).message, "error");
			return;
		}
		emitModelStatus(ctx);
		ctx.ui.notify(`Subagent default set to "${spec}" (saved to ~/.claude/settings.json).`, "info");
	};

	pi.registerCommand("subagent", {
		description: "Set the default model for subagent/workflow runs: /subagent [provider/model-id|inherit|status|clear]",
		getArgumentCompletions: (prefix) =>
			["inherit", "status", "clear"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const typed = args.trim();
			if (typed === "clear") {
				try {
					persistSubagentModel(undefined, os.homedir());
				} catch (error) {
					ctx.ui.notify("Could not update settings: " + (error as Error).message, "error");
					return;
				}
				emitModelStatus(ctx);
				ctx.ui.notify(
					"subagentModel cleared — the default is CLAUDE_CODE_SUBAGENT_MODEL or managed settings when applicable, else One Code's automatic same-provider profile.",
					"info",
				);
				return;
			}
			if (typed === "inherit") {
				await applySubagentModelChoice("inherit", ctx);
				return;
			}
			if (typed === "status") {
				showSubagentModelStatus(ctx);
				return;
			}
			if (typed) {
				await applySubagentModelChoice(typed, ctx);
				return;
			}

			// The picker needs focus and a terminal; elsewhere show status.
			if (!ctx.hasUI || ctx.mode !== "tui") {
				showSubagentModelStatus(ctx);
				return;
			}
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models are available — authenticate a provider first.", "warning");
				return;
			}
			const configured = loadSubagentDefault(os.homedir());
			const current = configured && configured.spec.includes("/") ? configured.spec : undefined;
			const entries = toPickerEntries(available);

			const chosen = await ctx.ui.custom<PickerEntry | null>((tui, theme, _keybindings, done) =>
				modelPickerComponent(
					{
						entries,
						current,
						title: "Select the default subagent model",
						subtitle:
							"Default for subagent/workflow runs unless overridden · type to filter · ↑/↓ · enter · esc",
					},
					tui,
					theme,
					done,
				),
			);

			if (chosen) await applySubagentModelChoice(pickerSpec(chosen), ctx);
		},
	});
}
