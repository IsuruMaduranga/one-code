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
 * "worktree"`, background execution (every run returns immediately — CC parity
 * — stays addressable via task_output/task_stop, and steers its completion
 * into the conversation as a system notification), and SendMessage (reach a
 * running agent live, or resume a finished one with its context intact —
 * children persist their sessions per run to make that possible).
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../auto-mode/actions.ts";
import { type AgentDefinition, type AgentSource, agentDirs, discoverAgents } from "./agents.ts";
import { modelIdentity, modelSpec } from "../lib/model-policy.ts";
import { applicableSubagentDefault, loadSubagentDefault, persistSubagentModel, type SubagentDefault } from "./default-model.ts";
import {
	expensiveModelGate,
	resolveSubagentModel,
	type SubagentModelResolution,
	SUBAGENT_STATUS_CHANNEL,
	subagentModelsReminder,
	subagentStatusModel,
} from "./model-select.ts";
import { modelPickerComponent, pickerSpec, toPickerEntries, type PickerEntry } from "../auto-mode/model-picker.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { MCP_TOOLS_CHANNEL, type McpToolsPayload } from "../lib/mcp-share.ts";
import { resolveModelTier } from "../lib/model-tier.ts";
import { watchPermissionBridge } from "../permissions/subagent-gate.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { type BackgroundTask, generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import { type ChildAction } from "../auto-mode/actions.ts";
import { type ChildOutcome, forkTaskMessage, OUTPUT_CAP, type RpcChildHandle } from "./outcome.ts";
import { type AgentRunRecord, nextRunName, RunRegistry } from "./runs.ts";
import { SubagentRuntime } from "./runner.ts";
import { emptyUsage, formatStats, type UsageTotals } from "./usage.ts";
import { cleanupWorktree, createWorktree, isGitRepo, type Worktree } from "./worktree.ts";
import { findGitRoot } from "../lib/git.ts";
import { registerWorktreeIsolation } from "../lib/worktree-isolation.ts";
import { createTaskNotifier, sessionOutlivesTurn, systemNotification } from "../lib/notifications.ts";
import { ccToolRenderers, customMessageText, notificationComponent, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { deriveActivity, LiveRunRegistry } from "./live-runs.ts";
import { DELEGATION_STEER } from "./delegation-steer.ts";
import { awaitHandBackReview, withReview } from "./hand-back-review.ts";
import type { LiveSink } from "./runner.ts";
import { recordUsage } from "../lib/usage-bus.ts";
import { SubagentWidget } from "./panel-widget.ts";
import { type ProseRenderer, renderTranscript } from "./panel-render.ts";
import { decodeStripKey, type StripKey } from "./panel-keys.ts";
import { reduceShellKey } from "./shell-panel.ts";
import { trackShellTasks } from "../lib/shell-tasks.ts";
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
	action: Type.Optional(
		StringEnum(["run", "list"] as const, {
			description: '"run" (the default) executes; "list" only browses the agent catalog and ignores run options',
		}),
	),
});

export const FORK_AGENT = "fork";

/** Floor between interim output.log rewrites (onProgress fires per tool call/message). */
const LOG_WRITE_INTERVAL_MS = 250;
/** Idle time after which a resident agent session is released (its session file keeps it reachable). */
const RESIDENT_IDLE_MS = 15 * 60_000;

/** A background agent's process, kept alive after its run so it can be messaged. */
interface Resident {
	handle: RpcChildHandle;
	/**
	 * FIFO — the head entry handles the next turn_end (initial task, then one per
	 * idle-time message). `review` is auto mode's rendered hand-back flag for
	 * that turn (undefined when clean or auto mode is off); the handler puts it
	 * ahead of the report in its notification.
	 */
	turnHandlers: Array<(outcome: ChildOutcome, review: string | undefined) => void>;
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const registry = new RunRegistry();
	/** Names with a blocking child (nested spawn or SendMessage resume) currently running (SendMessage must wait for these). */
	const runningNames = new Set<string>();
	const residents = new Map<string, Resident>();

	// The live subagent panel (Claude Code's below-editor agent tree): a registry
	// of every in-process child fed by the runner's live sink, a below-editor
	// strip, and taskId→kill handles for the viewer's stop/stop-all. The same
	// widget carries the background-shell manager (chip → list → details), fed
	// by the bash tasks that cross TASK_REGISTER_CHANNEL.
	const liveRuns = new LiveRunRegistry();
	const liveHandles = new Map<string, { kill(): void }>();
	let lastCtx: ExtensionContext | undefined;
	const shellTasks = trackShellTasks(pi);
	const panel = new SubagentWidget(liveRuns, () => lastCtx, shellTasks);

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
			onUsage: (usage) => recordUsage(pi, "subagent", usage),
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
	// The parent's MCP connect runs in the background, so a spawn in the first
	// seconds of a session waits for the settled publish (capped, so a hung server
	// can't stall spawns) instead of baking in a still-connecting snapshot.
	const MCP_SETTLE_CAP_MS = 10_000;
	let mcpTools: ToolDefinition[] = [];
	let mcpSettled = false;
	let resolveMcpSettled: (() => void) | undefined;
	const mcpSettledPromise = new Promise<void>((resolve) => {
		resolveMcpSettled = resolve;
	});
	pi.events.on(MCP_TOOLS_CHANNEL, (data) => {
		const payload = data as McpToolsPayload | undefined;
		mcpTools = payload?.tools ?? [];
		if (payload?.settled) {
			mcpSettled = true;
			resolveMcpSettled?.();
		}
	});
	const awaitMcpTools = async (): Promise<ToolDefinition[]> => {
		if (!mcpSettled) {
			await Promise.race([
				mcpSettledPromise,
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, MCP_SETTLE_CAP_MS);
					timer.unref?.();
				}),
			]);
		}
		return mcpTools;
	};

	// The parent permissions extension's decision closure, used to gate a child's
	// tool calls through the real pipeline (mode inheritance, classifier, prompts
	// bubbled to the user). Undefined until permissions emits it at session start;
	// a child built before then falls back to the fail-closed local gate.
	const getPermissionBridge = watchPermissionBridge(pi);

	/** The in-process runner, built lazily on first run and shared across all runs. */
	let runtimePromise: Promise<SubagentRuntime> | undefined;
	const getRuntime = (ctx: ExtensionContext) =>
		(runtimePromise ??= SubagentRuntime.create(
			ctx.cwd,
			awaitMcpTools,
			getPermissionBridge,
		));

	const loadAgents = (cwd: string) => {
		// Plugin agents sit between bundled and user definitions, and are exposed
		// namespaced (`<plugin>:<agent>`) so two plugins can ship the same name.
		const sources: Array<string | AgentSource> = [
			BUNDLED_AGENTS_DIR,
			...discoverPlugins(defaultDiscoverRoots(getAgentDir(), cwd)).agentDirs,
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
		/** Loop-invariant; computed lazily so worktree-free histories pay nothing. */
		let sharedRoot: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			// Both the current names and the pre-rename ones, so runs recorded before the
			// Agent/SendMessage rename still reconstruct on resume.
			if (msg.role !== "toolResult" || !["Agent", "SendMessage", "subagent", "send_message"].includes(msg.toolName ?? "")) continue;
			const records = (msg.details as { agentRuns?: AgentRunRecord[] } | undefined)?.agentRuns;
			for (const record of records ?? []) {
				registry.add(record);
				// A kept worktree can host a resumed run in a NEW process, where
				// createWorktree's registration no longer exists — re-register so the
				// git-isolation guard survives the restart. A removed worktree's entry
				// is inert (no session runs there any more). findGitRoot instead of
				// `git rev-parse` because session_start handlers must stay fast
				// (findings §15); a slightly-off sharedRoot only softens one message —
				// the worktree containment check itself uses the exact record.cwd.
				if (record.worktree) {
					sharedRoot ??= findGitRoot(ctx.cwd) ?? ctx.cwd;
					registerWorktreeIsolation(record.cwd, sharedRoot);
				}
			}
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
	 * Session-scoped cache of the AUTOMATIC subagent default (no per-call or agent
	 * override), so the O(catalog) ranking is not rebuilt on every turn (the
	 * every-turn reminder/banner) or every no-override spawn. Keyed on the session
	 * model plus the configured default; catalog churn is deliberately ignored,
	 * matching the classifier's pin — the session commits to one default worker,
	 * and /model or /subagent both change the signature and recompute. A per-call
	 * `model` or an agent's frontmatter model still resolves fresh (they vary).
	 */
	let autoDefaultCache: { signature: string; resolution: SubagentModelResolution } | undefined;
	const resolveAutoDefault = (
		sessionModel: Model<Api> | undefined,
		available: Model<Api>[],
		configured: SubagentDefault | undefined,
	): SubagentModelResolution => {
		const session = sessionModel ? modelSpec(sessionModel) : "(none)";
		const signature = `${session}|${configured?.spec ?? ""}|${configured?.setForContainment ?? ""}|${configured?.source ?? ""}`;
		if (autoDefaultCache?.signature === signature) return autoDefaultCache.resolution;
		const resolution = resolveSubagentModel({ configuredDefault: configured, sessionModel, available });
		autoDefaultCache = { signature, resolution };
		return resolution;
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
		const resolution = resolveAutoDefault(sessionModel, available, configured);
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

	const emitDelegationSteer = (sessionModel = lastCtx?.model) => {
		if (resolveModelTier(sessionModel) === "tiny") {
			pi.events.emit(REMINDER_CHANNEL, {
				scope: "every-turn",
				key: "subagent-delegation",
				text: DELEGATION_STEER,
				placement: "first-prepend",
				order: CONTEXT_ORDER.delegation,
			});
		} else {
			pi.events.emit(REMINDER_CHANNEL, { key: "subagent-delegation", remove: true });
		}
	};

	let shuttingDown = false;
	let currentSessionId: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		// A NEW session (/clear, /new) must not keep the old one's agents: a
		// resident finishing later would post into a conversation that never
		// spawned it, and its name would shadow a new run's (review S5).
		const id = ctx.sessionManager.getSessionId?.();
		if (currentSessionId !== undefined && id !== currentSessionId) {
			stopAllAgents();
			residents.clear();
			liveHandles.clear();
			runningNames.clear();
			registry.clear();
		}
		currentSessionId = id;
		reconstructRuns(ctx);
		emitModelStatus(ctx);
		emitAgentCatalog(ctx);
		emitDelegationSteer(ctx.model);
		registerPanelInputHook(ctx);
	});
	pi.on("model_select", (event, ctx) => {
		emitModelStatus(ctx, event.model);
		emitDelegationSteer(event.model);
	});
	pi.on("session_tree", (_event, ctx) => reconstructRuns(ctx));
	pi.on("session_shutdown", async () => {
		// Teardown: kills must not surface as "terminated" notifications, and the
		// worktree cleanups the exits trigger get a bounded moment to finish
		// before the process goes (review S14).
		shuttingDown = true;
		const exits = [...liveHandles.values()].map((h) => ("result" in h ? (h as { result?: Promise<unknown> }).result : undefined)).filter(Boolean);
		stopAllAgents();
		panel.dispose();
		await Promise.race([Promise.allSettled(exits), new Promise((resolve) => setTimeout(resolve, 1_500))]);
	});

	// --- The subagent panel: strip soft focus + Enter-to-view transcript swap ---

	/** Stop one live agent by task id (blocking-run handle or resident task). */
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
	 * Claude Code's agent view: with no view open, arrows move the strip
	 * selection and Enter swaps the transcript region to the selected child (a
	 * non-capturing full-width overlay composited over the main transcript; the
	 * editor keeps focus, strip keys keep working). Once a view IS open the panel
	 * switches to read mode (see the input hook): arrows/page keys scroll it, Tab
	 * retargets to the next agent, Enter/esc close it and the main transcript is
	 * back.
	 */
	let view: { retarget(taskId: string): void; scrollBy(delta: number): void; close(): void } | undefined;
	/** Rows kept clear at the bottom: token counter + editor(3) + mode line + strip hint + strip rows + shell section + cwd/status(2) + one spare. */
	const viewReserve = () => {
		const shellLines = panel.shellLineCount();
		return panel.rowCount() + (shellLines ? shellLines + 1 : 0) + 9;
	};

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
				panel.setView(id);
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
				panel.setView(undefined);
				doneFn?.(null);
			},
		};
		view = entry;
		panel.setView(currentId);
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
		})().catch(() => entry.close()); // full teardown (clears view + panel.setView) so state can't desync
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
		type KeyResult = { consume: boolean } | undefined;
		// Actions shared by both key modes (browse and read), declared once so the
		// two switches below never drift. esc consumes only when idle — a streaming
		// turn must stay interruptible.
		const doLeave = (ctx: ExtensionContext): KeyResult => {
			leave();
			return ctx.isIdle() ? { consume: true } : undefined;
		};
		// `taskId` targets a specific run (read mode stops the VIEWED agent, which
		// can differ from the windowed strip selection); default is the selection.
		const doStop = (taskId?: string): KeyResult => {
			const id = taskId ?? panel.selectedRun()?.taskId;
			if (id) stopAgent(id);
			return { consume: true };
		};
		const doStopAll = (): KeyResult => {
			stopAllAgents();
			return { consume: true };
		};
		/** Unrecognized key: ctrl+x keeps the stop-all chord armed, else drop focus
		 * (closing any open view) and let the byte resume in the editor. */
		const closeAndPassthrough = (): KeyResult => {
			if (chordArmed) return { consume: true };
			leave();
			return undefined;
		};
		const DOWN_KEYS = new Set(["\x1b[B", "\x1bOB"]);
		/** Keys the agents branch owns; any other decode (typing, shell-only keys
		 * like left/space) drops focus and passes through — stated positively so a
		 * future StripKey addition is foreign here by default. */
		const AGENT_KEYS = new Set<StripKey>(["up", "down", "open", "leave", "stop", "stopAll", "pageUp", "pageDown"]);
		/** Row 0 exists only past the synthetic `main` row. */
		const focusFirstAgentRow = (): boolean => {
			if (panel.rowCount() <= 1) return false;
			panel.setFocus(0);
			return true;
		};
		/** The shell-manager stages (chip → list → details); agents keys untouched. */
		const handleShellKey = (data: string, ctx: ExtensionContext): KeyResult => {
			// Focus moved to a dialog/overlay — drop soft focus, let it have the key.
			if (!panel.editorFocused()) {
				panel.setShellFocus(undefined);
				return undefined;
			}
			// Derive the row order once per keystroke; every step below reuses it.
			const ids = panel.shellIds();
			const focus = panel.anchoredShellFocus(ids);
			if (!focus) return undefined;
			const decoded = decodeStripKey(data, false);
			// ctrl+x (the agents stop-all chord arm) means nothing in the shell
			// stages — swallow it rather than leaking the raw \x18 into the editor.
			if (decoded.chordArmed) return { consume: true };
			const result = reduceShellKey(focus, decoded.key, ids);
			if (result.effect === "passthrough") {
				panel.setShellFocus(undefined);
				return undefined; // typing resumes in the editor, byte included
			}
			if (result.effect === "toAgents") {
				// No agent rows to land on → the byte passes through to the editor,
				// consistent with the initial-entry branch.
				panel.setShellFocus(undefined);
				return focusFirstAgentRow() ? { consume: true } : undefined;
			}
			if (result.effect === "stopSelected") {
				try {
					panel.selectedShellTask()?.stop();
				} catch {
					// A dead process's stop() throwing must not break the panel.
				}
				panel.setShellFocus(result.focus, ids);
				return { consume: true };
			}
			panel.setShellFocus(result.focus, ids);
			// While the model streams, esc must still interrupt it — consume only when idle.
			if (decoded.key === "leave" && result.focus === undefined) {
				return ctx.isIdle() ? { consume: true } : undefined;
			}
			return { consume: true };
		};
		try {
			registerCtx.ui.onTerminalInput((data) => {
				const ctx = lastCtx ?? registerCtx;
				// Enter focus: down-arrow while the editor holds real focus. Unlike the
				// workflow strip we do NOT require the editor to be idle — the whole
				// point is inspecting agents (and shells) that run while the main turn
				// is in flight. This branch is the per-keystroke hot path — the
				// O(rows) checks run only once a Down actually asks to focus, never on
				// plain typing. Claude Code's order: the FIRST ↓ lands on the shells
				// chip when shells are running; the next ↓ moves into the agent rows.
				if (panel.focusIndex === undefined && panel.shellFocus === undefined) {
					if (!DOWN_KEYS.has(data) || !panel.editorFocused()) return undefined;
					if (panel.shellChipAvailable()) {
						panel.setShellFocus({ stage: "chip" });
						return { consume: true };
					}
					return focusFirstAgentRow() ? { consume: true } : undefined;
				}
				if (panel.shellFocus !== undefined) return handleShellKey(data, ctx);
				const focusIndex = panel.focusIndex;
				if (focusIndex === undefined) return undefined; // unreachable: one of the two focuses was set
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
				// Read mode: while a transcript view is open the arrows/page keys
				// scroll IT (the natural gesture — pi's main screen has no mouse
				// wheel, so PageUp/PageDown alone were the only path and few reach
				// for them), Tab retargets to the next agent, Enter/esc close, and
				// ← closes the transcript but keeps the panel focused on that agent
				// (setView parked the highlight there) so ↑/↓ can pick a different
				// agent and Enter reopens — Claude Code's back-to-selection gesture.
				if (view) {
					switch (decoded.key) {
						case "up":
							view.scrollBy(1);
							return { consume: true };
						case "down":
							view.scrollBy(-1);
							return { consume: true };
						case "pageUp":
							view.scrollBy(10);
							return { consume: true };
						case "pageDown":
							view.scrollBy(-10);
							return { consume: true };
						case "left":
							closeView();
							return { consume: true };
						case "switch": {
							// Retarget to the next agent, anchored to the VIEWED run in the
							// full row list (not the windowed selection) so it stays correct
							// once the viewed run scrolls past MAX_STRIP_ROWS; setView then
							// moves the strip highlight to it when it is in-window.
							const nextId = panel.nextAgentAfter(panel.viewedTaskId());
							if (nextId) openView(ctx, nextId);
							return { consume: true };
						}
						case "open": // Enter toggles the view shut, mirroring Enter-to-open.
							closeView();
							return { consume: true };
						case "leave":
							return doLeave(ctx);
						case "stop":
							// Stop the agent whose transcript is open, not the strip selection.
							return doStop(panel.viewedTaskId());
						case "stopAll":
							return doStopAll();
						default:
							return closeAndPassthrough(); // typing closes the view and resumes in the editor
					}
				}
				if (!decoded.key || !AGENT_KEYS.has(decoded.key)) return closeAndPassthrough();
				switch (decoded.key) {
					case "up":
						if (focusIndex === 0) {
							// Back up out of the agent rows: onto the shells chip when
							// shells are running, otherwise out of the panel entirely.
							leave();
							if (panel.shellChipAvailable()) panel.setShellFocus({ stage: "chip" });
						} else panel.setFocus(focusIndex - 1);
						return { consume: true };
					case "down":
						panel.setFocus(Math.min(panel.rowCount() - 1, focusIndex + 1));
						return { consume: true };
					case "leave":
						return doLeave(ctx);
					case "open": {
						// Claude Code's model: Enter swaps the view to the selection (and
						// switches an open view); Enter on `main` restores the main
						// transcript. Focus stays in the strip for the next switch.
						const run = panel.selectedRun();
						if (run) openView(ctx, run.taskId);
						else closeView();
						return { consume: true };
					}
					case "stop":
						return doStop();
					case "stopAll":
						return doStopAll();
					case "pageUp":
					case "pageDown":
						// No transcript open → nothing to scroll; swallow so the page
						// keys never leak into the editor while the strip holds focus.
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

	const notifier = createTaskNotifier(pi);
	/** Every subagent notification; silent during shutdown (a teardown kill is not news). */
	const notify: typeof notifier = (customType, text, details) => {
		if (shuttingDown) return;
		notifier(customType, text, details);
	};

	/**
	 * A child's message to the main conversation is capped: it is unmetered model
	 * output landing in the parent's context, N children at once (review S4). The
	 * child is told where the cut is so it can put long content in a file.
	 */
	const MESSAGE_TO_MAIN_CAP = 10_000;

	/** Relay a child's send_message {to: "main"} into this conversation. */
	const notifyAgentMessage = (name: string, message: string, summary?: string) => {
		const body =
			message.length > MESSAGE_TO_MAIN_CAP
				? `${message.slice(0, MESSAGE_TO_MAIN_CAP)}\n… [message truncated at ${MESSAGE_TO_MAIN_CAP / 1000} KB — long content belongs in a file the parent can read]`
				: message;
		notify("subagent-message", systemNotification(`Message from agent ${name}${summary ? ` (${summary})` : ""}:\n\n${body}`), {
			name,
			summary,
		});
	};

	/** A fork's system prompt is persisted beside its session so a later resume can restore it (review S6). */
	const FORK_PROMPT_FILE = "system-prompt.md";
	const persistForkPrompt = (record: AgentRunRecord, prompt: string) => {
		if (!record.sessionSearchDir) return;
		try {
			writeFileSync(join(record.sessionSearchDir, FORK_PROMPT_FILE), prompt);
		} catch {
			// The run still works; only a later resume loses the prompt (and says so).
		}
	};
	const readForkPrompt = (record: AgentRunRecord): string | undefined => {
		if (!record.sessionSearchDir) return undefined;
		try {
			return readFileSync(join(record.sessionSearchDir, FORK_PROMPT_FILE), "utf-8");
		} catch {
			return undefined;
		}
	};

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
				"Delegate a scoped task to a specialist subagent running in its own context window. The call BLOCKS until the agent finishes and returns its report — use it for well-scoped work whose intermediate output you don't need (broad searches, focused verification, independent research). Give a complete, self-contained task: the agent cannot ask follow-ups. If an agent's description says it should be used proactively, use it without being asked. Available agents:\n" +
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
				const agents = loadAgents(parentRecord.cwd);
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
					// The SPAWNING agent's cwd, not the top-level session's: a worktree-
					// isolated parent's nested spawns must work in the same worktree.
					cwd: parentRecord.cwd,
					model: resolved,
					thinking: undefined,
					depth: parentDepth + 1,
				};
				registry.add(record); // SendMessage from main can reach the nested run too

				// The main conversation's Agent calls are classified as delegations
				// (matcher DELEGATION_TOOLS); a child's nested spawn must be judged the
				// same way — a prompt-injected child could otherwise hand a task the
				// parent would never be allowed to a grandchild unclassified (review
				// S8). The child's own gate never sees this call (Agent is NEVER_GATE
				// there), so route it through the parent's bridge here. Fails closed.
				try {
					const bridge = getPermissionBridge();
					const verdict = bridge
						? await bridge({ toolName: "Agent", input: { subagent_type: agentName, prompt: task, description: name }, cwd: parentRecord.cwd, signal })
						: { block: true as const, reason: "no permission bridge is available to judge the delegation" };
					if (verdict?.block) {
						return {
							content: [{ type: "text" as const, text: `Nested Agent call refused: ${verdict.reason}` }],
							details: { agentRuns: [] as AgentRunRecord[] },
							isError: true,
						};
					}
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Nested Agent call refused: permission check failed (${(error as Error).message}).` }],
						details: { agentRuns: [] as AgentRunRecord[] },
						isError: true,
					};
				}

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
					signal, // the spawning child aborting (stop/esc) kills the nested run
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

	/** Create a run's isolation worktree and point its record at it (both spawn paths). */
	const isolateInWorktree = async (ctx: ExtensionContext, record: AgentRunRecord, name: string): Promise<Worktree> => {
		const worktree = await createWorktree(ctx.cwd, name);
		record.cwd = worktree.path;
		record.worktree = true;
		return worktree;
	};

	/**
	 * Run one child to completion, blocking until it finishes — the shape a
	 * NESTED spawn needs (a child's own Agent call has no notification surface,
	 * so it waits for the result) and the one-shot modes need (a `-p` process
	 * exits when the turn settles, so a background run would be orphaned).
	 * Main-conversation runs in TUI/RPC sessions are background residents
	 * instead. Creates a worktree first if asked and finalizes the record when
	 * done. `parent` links the run under its parent in the panel tree.
	 */
	const executeRun = async (
		prepared: PreparedRun,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		forkFrom?: string,
		parent?: { taskId: string; depth: number },
		onProgress?: (toolCalls: number, text: string, usage: UsageTotals) => void,
	): Promise<TaskResult> => {
		const { request, record, agentDef } = prepared;

		let worktree: Worktree | undefined;
		if (request.worktree) {
			try {
				worktree = await isolateInWorktree(ctx, record, request.name);
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
				onProgress?.(toolCalls, text, usage);
			},
			sink: live.sink,
			onMessageToMain: (message, summary) => notifyAgentMessage(request.name, message, summary),
			extraTools: spawnToolsFor(record),
		});
		liveHandles.set(record.taskId, handle);

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
			'Delegate a task to a specialist agent that runs in its own context window and reports back. The available agents are listed in the "Available agents" system reminder.\n' +
			"\n" +
			"## When to use\n" +
			"- Broad codebase searches or exploration where you need the conclusion, not the file dumps.\n" +
			"- Self-contained research, reviews, or verification whose intermediate output you won't need again.\n" +
			"- Independent questions that can run at once — issue multiple Agent tool calls in one message to run them in parallel.\n" +
			"\n" +
			"For a single-fact lookup you already know how to run, search directly instead. Once you've delegated work, don't also run it yourself — wait for the result.\n" +
			"\n" +
			"## How agents run\n" +
			"Agents run in the background: the call returns immediately with a task id, and you'll be notified when one completes — the agent's report arrives as a system notification while you keep working, or on its own if you are idle. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running. Call task_output only if your next step cannot proceed without the result (block=true waits); stop a run with task_stop. (Exception: in a one-shot print session the call blocks and returns the report directly — no notification follows.)\n" +
			"\n" +
			"## Usage notes\n" +
			"- Give a complete, self-contained task: the agent cannot ask follow-up questions.\n" +
			"- If an agent's description says it should be used proactively, try your best to use it without the user having to ask first.\n" +
			'- `subagent_type: "fork"` clones this conversation instead of starting fresh; a fork always runs on this conversation\'s model and reasoning settings. If you are the fork, execute your assigned task directly — don\'t re-delegate.\n' +
			'- `isolation: "worktree"` gives the agent its own git worktree when it will edit files.\n' +
			"- Each run gets a name — SendMessage reaches it live while it runs and continues it after it finishes. `action: \"list\"` re-prints the agent catalog.\n" +
			"- The agent's final report is not shown to the user, so relay what matters.",
		promptSnippet: "Delegate scoped work to a specialist agent in its own context",
		parameters: SubagentParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(ctx.cwd);

			// A call carrying run options (a task, a name, a model/thinking/isolation
			// override, or action:"run") but no `subagent_type` is a run that forgot
			// to name its agent. Fail loudly with a diagnostic rather than silently
			// returning the catalog: a weaker model reads the catalog as a
			// non-sequitur and invents wrong reasons for it, instead of learning it
			// omitted `subagent_type`.
			const wantsRun =
				params.action === "run" ||
				params.task != null ||
				params.name != null ||
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
				// No per-call or agent-frontmatter override → the automatic default,
				// which is stable for the session, so reuse the cached resolution
				// instead of re-ranking the catalog per spawn. An override varies per
				// call and always resolves fresh.
				const resolution =
					p.request.model || p.agentDef?.model
						? resolveSubagentModel({
								requested: p.request.model,
								agentModel: p.agentDef?.model,
								configuredDefault: configuredDefault,
								sessionModel: ctx.model,
								available,
							})
						: resolveAutoDefault(ctx.model, available, configuredDefault);
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

			// One-shot modes (`-p` / `--mode json`) exit when the turn settles, so
			// a background run would be orphaned with its report undelivered — run
			// blocking there and return the report in the tool result instead.
			if (!sessionOutlivesTurn(ctx.mode)) {
				// Stream progress through onUpdate (tool_execution_update) like the
				// old foreground path — a headless JSON/RPC consumer has no panel,
				// so this is its only signal between dispatch and result.
				let progress = { toolCalls: 0, text: "", usage: emptyUsage() };
				const report = () => {
					const stats = formatStats(progress.toolCalls, progress.usage);
					const line = `${progress.text ? "✓" : "⏳"} ${prepared[0].request.name} (${stats})${progress.text ? "" : " running…"}`;
					onUpdate?.({ content: [{ type: "text", text: line }], details: {} });
				};
				report();
				const result = await executeRun(prepared[0], ctx, signal, sessionFile ?? undefined, undefined, (toolCalls, text, usage) => {
					progress = { toolCalls, text, usage };
					report();
				});
				// Auto mode reviews what the child actually did once it returns; the
				// permission gate attaches the review to this tool_result.
				pi.events.emit(SUBAGENT_ACTIONS_CHANNEL, {
					toolCallId,
					actions: result.actions ?? [],
				} satisfies SubagentActionsPayload);
				const stats = formatStats(result.toolCalls, result.usage);
				const worktreeNote = result.worktreePath ? `\n\n(Changes left in worktree ${result.worktreePath} — review or merge them.)` : "";
				return {
					content: [{ type: "text", text: `${result.output}${worktreeNote}\n\n(${stats})` }],
					details: { results: [result], agentRuns: records },
					isError: result.failed ?? false,
				};
			}

			// Every run is a background resident (Claude Code parity): the call
			// returns as soon as the child is launched, the report arrives as a
			// steered system notification, and the child stays resident so
			// SendMessage can reach it live (steer mid-turn, prompt when idle).
			const lines: string[] = [];
			const runtime = await getRuntime(ctx);
			for (const p of prepared) {
				let worktree: Worktree | undefined;
				if (p.request.worktree) {
					try {
						worktree = await isolateInWorktree(ctx, p.record, p.request.name);
					} catch (error) {
						lines.push(`✗ ${p.record.name}: could not create a worktree: ${(error as Error).message}`);
						continue;
					}
				}

				const logPath = p.record.sessionSearchDir ? join(p.record.sessionSearchDir, "output.log") : undefined;
				let lastLogWrite = 0;
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
				// The initial task's own report. task_output for THIS task must return the
				// first turn's reply — not the resident's growing multi-turn transcript —
				// the same way a SendMessage task returns one reply (review S12).
				let firstTurnOutput: string | undefined;
				const live = trackLiveRun(p.record, p.request);
				const resident: Resident = { handle: undefined as never, turnHandlers: [] };
				const worktreeNote = worktree
					? `\n\n(Running in worktree ${worktree.path} — kept while the agent stays resident.)`
					: "";
				resident.turnHandlers.push((outcome, review) => {
					task.status = outcome.failed ? "failed" : "completed";
					task.finishedAt = Date.now();
					firstTurnOutput = outcome.output;
					finish();
					const stats = formatStats(outcome.toolCalls, outcome.usage);
					notify(
						"subagent-result",
						systemNotification(
							withReview(
								`Agent ${p.record.name} (task ${p.record.taskId}) ${outcome.failed ? "failed" : "completed"} (${stats}). It stays reachable with SendMessage.\n\n${outcome.output.slice(0, OUTPUT_CAP)}${worktreeNote}`,
								review,
							),
						),
						{ taskId: p.record.taskId, name: p.record.name, failed: outcome.failed ?? false, reviewed: review !== undefined },
					);
				});

				// Idle reaper: every run is a resident now, so without this a long
				// session accumulates one live AgentSession (extension instances,
				// message array, MCP tool refs) per delegation for its whole life.
				// After RESIDENT_IDLE_MS idle the session is released quietly; the
				// agent stays reachable — SendMessage resumes it from its session
				// file. Worktree residents are exempt: release would remove the
				// worktree a resume still needs. Armed from every turn end.
				let reaper: ReturnType<typeof setTimeout> | undefined;
				const armReaper = () => {
					if (worktree) return;
					if (reaper) clearTimeout(reaper);
					reaper = setTimeout(() => {
						reaper = undefined;
						if (handle.exited()) return;
						if (handle.busy()) {
							armReaper();
							return;
						}
						handle.release();
					}, RESIDENT_IDLE_MS);
					reaper.unref?.();
				};
				// Captured as a string: onExit runs from a `.finally` long after this
				// turn's ctx may be stale (review S5).
				const parentCwd = ctx.cwd;
				const forkPrompt = p.request.fork ? ctx.getSystemPrompt() : undefined;
				if (forkPrompt !== undefined) persistForkPrompt(p.record, forkPrompt);
				// No `signal` here on purpose: a resident outlives the spawning turn and
				// is stopped through task_stop / the panel, not by the turn ending (S15).
				const handle = await runtime.runResident({
					agent: p.agentDef,
					cwd: p.record.cwd,
					forkFrom: p.request.fork ? (sessionFile ?? undefined) : undefined,
					parentSystemPrompt: forkPrompt,
					sessionDir: p.record.sessionSearchDir || undefined,
					model: p.request.model,
					fallbackModel: p.request.fallbackModel,
					thinking: p.request.thinking,
					onProgress: (toolCalls, text, usage) => {
						live.progress(toolCalls, usage);
						// Throttled: onProgress fires per tool call/message with the whole
						// turn text so far, and this path now carries EVERY run — an
						// unthrottled sync rewrite would be O(n²) bytes on the hot path.
						// onTurnEnd below flushes the final state, so the tail is never lost.
						if (logPath && text && Date.now() - lastLogWrite > LOG_WRITE_INTERVAL_MS) {
							lastLogWrite = Date.now();
							writeFileSync(logPath, text);
						}
					},
					sink: live.sink,
					onMessageToMain: (message, summary) => notifyAgentMessage(p.record.name, message, summary),
					extraTools: spawnToolsFor(p.record),
					onTurnEnd: (outcome) => {
						registry.sessionFileFor(p.record);
						live.settle();
						lastOutput = resident.handle.snapshot().text || outcome.output;
						if (logPath) writeFileSync(logPath, lastOutput);
						// The handler is claimed now (so a message arriving mid-review pairs
						// with the NEXT turn), but runs only once auto mode's hand-back
						// review of this turn's action sequence has answered, so the
						// verdict rides in the same notification as the report instead of
						// trailing it. The wait is bounded (hand-back-review.ts) and
						// answered synchronously when auto mode is off.
						const handler = resident.turnHandlers.shift();
						armReaper();
						void awaitHandBackReview(pi.events, p.record, outcome.actions).then((review) => {
							if (handler) {
								handler(outcome, review);
							} else {
								// A turn nobody is waiting on (e.g. a steer that raced past its
								// target turn and ran on its own) must still surface.
								notify(
									"subagent-result",
									systemNotification(withReview(`Update from ${p.record.name}:\n\n${outcome.output.slice(0, OUTPUT_CAP)}`, review)),
									{ name: p.record.name, failed: outcome.failed ?? false, reviewed: review !== undefined },
								);
							}
						});
					},
					onExit: () => {
						if (reaper) clearTimeout(reaper);
						live.finish(false);
						if (residents.get(p.record.name) === resident) residents.delete(p.record.name);
						liveHandles.delete(p.record.taskId);
						if (worktree) void cleanupWorktree(parentCwd, worktree);
					},
				});
				resident.handle = handle;
				residents.set(p.record.name, resident);
				liveHandles.set(p.record.taskId, handle);

				const task: BackgroundTask = {
					id: p.record.taskId,
					kind: "subagent",
					ownUI: true, // rendered live by the subagents panel's agent strip
					description: `${p.record.name}: ${p.request.task.slice(0, 80)}`,
					status: "running",
					startedAt: Date.now(),
					logPath,
					output: () => firstTurnOutput ?? (handle.snapshot().text || lastOutput),
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
						text: `${lines.join("\n")}\n\nCompletion (with the agent's report) will arrive as a system notification on its own — you do not need to wait for it or poll; keep working. Call task_output only if your next step cannot proceed without the result (block=true waits). Stop with task_stop; SendMessage reaches the agent even while it runs (the message is steered into its current turn).`,
					},
				],
				details: { agentRuns: records, background: true },
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
					ownUI: true, // rendered live by the subagents panel's agent strip
					description: `message to ${record.name}${params.summary ? `: ${params.summary}` : ""}`,
					status: "running",
					startedAt: Date.now(),
					output: () => replyOutput || resident.handle.snapshot().text,
					stop: () => resident.handle.kill(),
					resident: () => !resident.handle.exited(),
					finished,
				};
				resident.turnHandlers.push((outcome, review) => {
					task.status = outcome.failed ? "failed" : "completed";
					task.finishedAt = Date.now();
					replyOutput = outcome.output;
					finish();
					const stats = formatStats(outcome.toolCalls, outcome.usage);
					notify(
						"subagent-result",
						systemNotification(withReview(`Reply from ${record.name} (${stats}):\n\n${outcome.output.slice(0, OUTPUT_CAP)}`, review)),
						{ taskId, name: record.name, failed: outcome.failed ?? false, reviewed: review !== undefined },
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
			// A fork has no agent definition: its identity is the parent's prompt at
			// spawn time, persisted beside its session. Without it a resume would run
			// on pi's stock prompt and default tools — refuse instead (review S6).
			const forkPrompt = record.agent === FORK_AGENT ? readForkPrompt(record) : undefined;
			if (record.agent === FORK_AGENT && forkPrompt === undefined) {
				return {
					content: [
						{
							type: "text",
							text: `Agent ${record.name} is a fork whose system prompt was not persisted (it ran before fork resume was supported, or its files were removed), so it cannot be resumed faithfully. Start a fresh run instead.`,
						},
					],
					details: {},
					isError: true,
				};
			}
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
				parentSystemPrompt: forkPrompt,
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
				ownUI: true, // rendered live by the subagents panel's agent strip
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
	// even while a blocking run of the same name is in flight): resident-live
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
			ctx.ui.notify('Subagent default set to the session model ("inherit", saved to ~/.onecode/settings.json).', "info");
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
		ctx.ui.notify(`Subagent default set to "${spec}" (saved to ~/.onecode/settings.json).`, "info");
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
