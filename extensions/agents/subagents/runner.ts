/**
 * In-process subagent execution. Replaces the per-subagent `pi` process (the
 * retired child.ts) with a real `createAgentSession()` in this process — the
 * same technique the workflow runner uses, extended with the subagent tool's
 * needs: named/persisted runs (for SendMessage resume), fork (inherit the
 * parent transcript), and the child-only SendMessage→main tool.
 *
 * One SubagentRuntime is built lazily per extension and shared across all runs:
 * a single ModelRuntime. Each run gets its own AgentSession — and its own
 * resource loader, since disposing a session kills the loader it ran on
 * (lib/agents/agent-loader.ts) — backed by a persisted SessionManager under
 * `<sessionDir>/subagents/<taskId>/`, so a finished run can be resumed from disk.
 */

import { childWriteWatcher } from "../../lib/agents/child-writes.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { type AgentSession, type ExtensionAPI, type ExtensionError, getAgentDir, SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { whenAborted } from "../../lib/core/abort.ts";
import { type AgentLoaderOptions, buildAgentLoader, createSharedModelRuntime, withParentSessionId, disposeChildSession, openChildSession } from "../../lib/agents/agent-loader.ts";
import { agentPromptIdentity, PrefixWarmGate, prefixWarmKey, type Release } from "../../lib/side-calls/prefix-warm-gate.ts";
import type { PermissionBridge } from "../../lib/agents/subagent-gate.ts";
import type { HookBridge } from "../../lib/agents/hook-bridge.ts";
import { findConfigured, modelSpec } from "../../lib/models/model-policy.ts";
import { isModelUnavailableError } from "../../lib/models/classifier-model.ts";
import { toolLive } from "../../lib/profile/profile.ts";
import { type LevelOwnership, tierThinkingAt } from "../../lib/models/tier-thinking.ts";
import { type AgentDefinition, agentToolOptions, childMcpTools, toolsRemovedByFlags, unusableAllowlistError } from "../../lib/agents/agent-catalog.ts";
import { childExtensionPaths } from "../../lib/agents/child-extensions.ts";
import { type HandbackSlot, SUBAGENT_HANDBACK, subagentHandbackExtension } from "../../lib/agents/subagent-handback.ts";
import type { RequestCapture } from "../../lib/side-calls/request-replay.ts";
import { forkCacheExtension, type ParentTool, withParentParameters } from "./fork-cache.ts";
import { agentStallMs, StallWatch } from "./stall-watch.ts";
import { knobValue } from "../../lib/profile/knobs.ts";

/** Claude Code's CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS, in the product's spelling. */
const AGENT_STALL_KNOB = "ASYNC_AGENT_STALL_TIMEOUT_MS";
import { parentModeExtension } from "./parent-mode.ts";
import { type DeferRequest, deferLikeParentExtension, injectedByParent } from "../../lib/request/deferred.ts";
import type { ChildHandle, ChildOutcome, RpcChildHandle } from "./outcome.ts";
import { sendToMainTool } from "./send-to-main-tool.ts";
import { type AbortReason, SessionTurnTracker, type TurnFailureSink } from "./session-turns.ts";
import { TURN_FAILED_CHANNEL, type TurnFailedEvent } from "../../lib/notify/interrupt.ts";
import type { UsageTotals } from "../../lib/agents/usage.ts";
import { streamingText, type TranscriptBlock } from "./live-runs.ts";
import { cutPlainText, firstNonEmptyLine, stripReminderBlocks, summarizeArgs, textContent } from "../../lib/ui/tui-render.ts";
import { subagentResultText } from "../../lib/agents/subagent-text.ts";

/**
 * Optional live sink for the subagent panel: a one-line activity string from
 * the latest tool call, transcript blocks (assistant text, tool calls, tool
 * results) as they settle, and the in-flight assistant message per streaming
 * delta (whole-so-far reference — the consumer extracts text lazily at paint
 * time, spinner-style, to stay O(1) per delta). Purely observational — never
 * affects the run.
 */
export interface LiveSink {
	onActivity?(toolName: string | undefined, args: unknown, lastText: string): void;
	onBlock?(block: TranscriptBlock): void;
	onStreaming?(message: { content?: unknown } | undefined): void;
	/** One child assistant message's usage, for the all-in footer cost. */
	onUsage?(usage: unknown): void;
}

/** Wall-clock cap on a single run/turn — a hung session shares the main event loop. */
const WALL_CLOCK_CAP_MS = 30 * 60 * 1000;

/**
 * Tools the runtime injects into a child; the permission gate must never gate
 * them. `SubagentHandback` only returns the child's report to its caller.
 * `Agent` is the injected child-spawn tool (index.ts) — the spawn itself
 * is free (matching the main conversation's auto-allowed Agent tool); every
 * tool call the spawned grandchild makes still runs through the real gate.
 */
const NEVER_GATE = new Set(["structured_output", "SendMessage", SUBAGENT_HANDBACK, "Agent"]);

type Session = AgentSession;

/** The fields buildChildSession needs — the common subset of a blocking and a resident run. */
interface ChildSessionSpec {
	cwd: string;
	/** The run's name, shown in the permission prompts its tool calls bubble to the user. */
	name?: string;
	agent?: AgentDefinition;
	/** Parent session file — present for a fork run (inherit the parent transcript). */
	forkFrom?: string;
	/** Messages appended to a fork's transcript before its task (e.g. `/btw`'s side exchange). */
	forkMessages?: Message[];
	/** The parent's current system prompt, applied to a fork so it continues as the parent. */
	parentSystemPrompt?: string;
	/**
	 * The parent's last provider request, for a fork: every fork request is
	 * built from it so the fork reads the parent's prompt cache (fork-cache.ts).
	 */
	parentRequest?: RequestCapture;
	/** The parent's registered tools, for a fork to stub the ones its own session lacks (fork-cache.ts). */
	parentTools?: readonly ParentTool[];
	/** Existing persisted session to resume (SendMessage to a finished agent). */
	sessionFile?: string;
	/** Where a new run's persisted session lands; falls back to an in-memory session. */
	sessionDir?: string;
	/** Resolved concrete model as `provider/id` (undefined for a fork — restored from the session). */
	model?: string;
	/**
	 * Session model to fall back to when `model` (an automatic pick) cannot spawn.
	 * Set only for non-per-call picks: a per-call model surfaces its error instead
	 * of being silently swapped. See buildChildSession.
	 */
	fallbackModel?: string;
	thinking?: string;
	/** The child called SendMessage {to: "main"} — relay it to the main conversation. */
	onMessageToMain?: (message: string, summary?: string) => void;
	/** Extra injected tools (e.g. the child-spawn Agent tool for depth-0 children). */
	extraTools?: ToolDefinition[];
	/**
	 * The main session's tool call that started the run's current turn, read
	 * per gated call (a SendMessage can start a later turn). The permission
	 * bridge passes it on as `ChildToolCall.parentToolCallId`.
	 */
	mainToolCallId?: () => string | undefined;
}

export interface SubagentRunOptions extends ChildSessionSpec {
	task: string;
	signal?: AbortSignal;
	/**
	 * The caller runs this turn as a background task (a SendMessage resume in a
	 * session that outlives the turn): its child gets the stall watch, as a
	 * resident does, so a silent agent fails instead of waiting out the wall-clock cap.
	 */
	background?: boolean;
	onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void;
	/** Optional live sink for the subagent panel (activity + transcript blocks). */
	sink?: LiveSink;
}

export interface ResidentRunOptions extends Omit<ChildSessionSpec, "sessionFile"> {
	onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void;
	/** Fires at the start of EVERY turn, before the child's first event; `onTurnEnd` is its pair. */
	onTurnStart?: () => void;
	/** Fires at the end of EVERY turn (initial task and later messages alike). */
	onTurnEnd: (outcome: ChildOutcome) => void;
	/** Fires once when the resident exits; a returned promise (worktree cleanup) is part of kill()'s settle. */
	onExit?: () => void | Promise<unknown>;
	/** Optional live sink for the subagent panel (activity + transcript blocks). */
	sink?: LiveSink;
}

/**
 * A child's session manager: a resume reopens its file; otherwise a fork
 * clones the parent transcript (when the parent has written one) and anything
 * else starts empty, and `forkMessages` are appended so the child sees them before
 * its task and a later resume finds them in its file. Exported for tests.
 */
export function newChildSessionManager(spec: Pick<ChildSessionSpec, "cwd" | "forkFrom" | "forkMessages" | "sessionFile" | "sessionDir">): SessionManager {
	// The resume cwd is passed explicitly: a worktree run's persisted cwd may
	// be gone by the time it is messaged (index.ts substitutes the parent cwd).
	if (spec.sessionFile) return SessionManager.open(spec.sessionFile, undefined, spec.cwd);
	// pi writes a session file with its first assistant reply, so a parent with
	// no transcript yet (or run with --no-session) has nothing to clone.
	const manager = spec.forkFrom && existsSync(spec.forkFrom)
		? SessionManager.forkFrom(spec.forkFrom, spec.cwd, spec.sessionDir)
		: spec.sessionDir
			? SessionManager.create(spec.cwd, spec.sessionDir)
			: SessionManager.inMemory(spec.cwd);
	for (const message of spec.forkMessages ?? []) manager.appendMessage(message);
	return manager;
}

/**
 * A fresh named agent whose call passed no `thinking` starts at the profile's
 * level for its own model's tier, under the main session's rules
 * (lib/models/tier-thinking.ts): a level the user picked in the parent
 * session (`parent.source` "user"), a level saved for the child's model,
 * pi's global default or a launch flag the parent's `/effort auto` did not
 * release keeps pi's own, as before tier levels existed. Set before the first prompt, and fitted by pi to the model, so
 * the level that runs can be higher than the one declared. A fork runs at
 * the parent's level, a resume at its branch's.
 */
export function applyChildTierDefault(session: Pick<AgentSession, "model" | "settingsManager" | "setThinkingLevel">, parent: LevelOwnership): void {
	const model = session.model;
	if (!model) return;
	const { level } = tierThinkingAt("child", model, session.settingsManager.getSettings(), parent);
	if (level !== undefined) session.setThinkingLevel(level);
}

/**
 * Whether pi has already ended the turn's run: it started (`agent_start`) and
 * the session is idle again, while pi still awaits the child's `agent_settled`
 * handlers before the settle event reaches the tracker. A kill in that window
 * cuts nothing short, so the turn keeps its real outcome; before the run starts
 * (queued behind the prefix gate) the session is idle too, but it never ran.
 */
function settledInPi(tracker: SessionTurnTracker, session: Pick<Session, "isIdle"> | undefined): boolean {
	return tracker.runStarted && session?.isIdle === true;
}

/** Prepend a one-time spawn note (e.g. a model fallback) to an outcome's output. */
function withNote(outcome: ChildOutcome, note: string | undefined): ChildOutcome {
	return note ? { ...outcome, output: `${note}\n\n${outcome.output}` } : outcome;
}

/**
 * A child extension that hands a guard's turn-failed reason to the run's
 * tracker: the child's bus is its own, so nothing else in the parent hears it.
 */
export function turnFailureExtension(sink: TurnFailureSink): (pi: Pick<ExtensionAPI, "events">) => void {
	return (pi) => {
		pi.events.on(TURN_FAILED_CHANNEL, (data) => {
			const reason = (data as TurnFailedEvent | undefined)?.reason;
			if (typeof reason === "string" && reason) sink.recordTurnFailure(reason);
		});
	};
}

/**
 * A child extension that fails a turn with no progress for `ms` (stall-watch.ts):
 * every streamed chunk (a message update, a raw provider event) is progress, a
 * tool or a compaction pauses the clock. It stops the turn as the tool-call
 * guard does, so turnFailureExtension carries the reason to the tracker.
 */
export function stallWatchExtension(ms: number): (pi: Pick<ExtensionAPI, "on" | "events">) => void {
	return (pi) => {
		let ctx: { abort(): void } | undefined;
		const watch = new StallWatch((seconds) => {
			pi.events.emit(TURN_FAILED_CHANNEL, { reason: subagentResultText().stalled({ seconds }) } satisfies TurnFailedEvent);
			try {
				ctx?.abort();
			} catch {
				// A child disposed mid-turn (no session_shutdown): nothing left to stop.
			}
		}, ms);
		const track = (handler: () => void) => (_event: unknown, context: { abort(): void }) => {
			ctx = context;
			handler();
		};
		pi.on("agent_start", track(() => watch.turnStarted()));
		pi.on("message_start", track(() => watch.replyStarted()));
		pi.on("message_update", track(() => watch.progress()));
		pi.on("provider_stream_event", track(() => watch.progress()));
		pi.on("tool_execution_start", track(() => watch.toolStarted()));
		pi.on("tool_execution_end", track(() => watch.toolEnded()));
		pi.on("session_before_compact", track(() => watch.compactionStarted()));
		pi.on("session_compact", track(() => watch.compactionEnded()));
		pi.on("session_compact_failed", track(() => watch.compactionEnded()));
		pi.on("agent_settled", () => watch.stop());
		pi.on("session_shutdown", () => watch.stop());
	};
}

export class SubagentRuntime {
	private readonly modelRuntime: Awaited<ReturnType<typeof createSharedModelRuntime>>;
	private readonly baseCwd: string;
	/**
	 * Live MCP tools shared in from the parent session (empty when no MCP
	 * servers). May be async: the parent's MCP connect runs in the background, so
	 * an early spawn awaits the settled set instead of snapshotting a
	 * still-connecting (possibly empty) one.
	 */
	private readonly getMcpTools: () => ToolDefinition[] | Promise<ToolDefinition[]>;
	/** The tools the parent session defers (lib/request/deferred.ts queryDeferred): a child defers the ones injected into it the same way. */
	private readonly getParentDeferred: () => DeferRequest[];
	/** The main session's live permission mode, for a fork: told to it when it differs from what it was told (parent-mode.ts). */
	private readonly getParentMode: (() => string) | undefined;
	/** Who set the main session's thinking level (lib/models/tier-thinking.ts levelOwnership); unknown counts as the user's. */
	private readonly getParentLevelOwnership: () => LevelOwnership;
	/**
	 * The parent's permission decision closure (undefined until permissions
	 * publishes it), wrapped so every call carries the asking run's name: the
	 * gate inside a child only knows its session id (one bridge wrapper serves
	 * every child, so the name cannot be baked in), and the parent's prompt
	 * title needs the name once two children ask back-to-back.
	 */
	private readonly getPermissionBridge: () => PermissionBridge | undefined;
	/** The parent hooks extension's bridge (undefined until hooks publishes it); the child's tool hooks. */
	private readonly getHookBridge: () => HookBridge | undefined;
	/** A child extension handler threw (pi swallows it otherwise); surfaced to the user by index.ts. */
	private readonly onExtensionError: (runName: string | undefined, error: ExtensionError) => void;
	private readonly onModelUnusable: (model: string, reason: string) => void;
	/** A child's edit or write changed a file (lib/agents/child-writes.ts); index.ts tells the parent's file-tracker. */
	private readonly onChildWrite: (path: string, runName: string | undefined) => void;
	/** Child session id → run name, for the bridge wrapper above. */
	private readonly runNames = new Map<string, string>();
	/** Child session id → agent type (`explore`, …), for the hook payload's `agent_type`. */
	private readonly agentTypes = new Map<string, string>();
	/** Child session id → the main-session call that started its turn, for the bridge wrapper. */
	private readonly mainToolCalls = new Map<string, () => string | undefined>();
	/**
	 * Parallel children with the same request prefix (same agent prompt and
	 * model; forks share the parent's) let the first one start streaming before
	 * the rest go, so the fan-out writes the shared prefix once and reads it
	 * N-1 times (lib/side-calls/prefix-warm-gate.ts).
	 */
	private readonly warmGate = new PrefixWarmGate();

	private constructor(
		modelRuntime: SubagentRuntime["modelRuntime"],
		baseCwd: string,
		getMcpTools: () => ToolDefinition[] | Promise<ToolDefinition[]>,
		getPermissionBridge: () => PermissionBridge | undefined,
		getHookBridge: () => HookBridge | undefined,
		onExtensionError: (runName: string | undefined, error: ExtensionError) => void,
		onModelUnusable: (model: string, reason: string) => void,
		onChildWrite: (path: string, runName: string | undefined) => void,
		getParentDeferred: () => DeferRequest[],
		getParentMode: (() => string) | undefined,
		getParentLevelOwnership: () => LevelOwnership,
	) {
		this.modelRuntime = modelRuntime;
		this.getParentDeferred = getParentDeferred;
		this.getParentMode = getParentMode;
		this.getParentLevelOwnership = getParentLevelOwnership;
		this.onChildWrite = onChildWrite;
		this.baseCwd = baseCwd;
		this.getMcpTools = getMcpTools;
		this.getHookBridge = getHookBridge;
		this.onExtensionError = onExtensionError;
		this.onModelUnusable = onModelUnusable;
		// One stable wrapper (the gate calls the getter per tool call; allocating a
		// closure each time would be waste). A bridge that vanished between the
		// getter and the call throws, which the gate turns into a fail-closed deny.
		const namedBridge: PermissionBridge = (call) => {
			const bridge = getPermissionBridge();
			if (!bridge) throw new Error("the parent's permission bridge is no longer available");
			return bridge({
				...call,
				agent: call.agent ?? (call.sessionId ? this.runNames.get(call.sessionId) : undefined),
				parentToolCallId: call.parentToolCallId ?? (call.sessionId ? this.mainToolCalls.get(call.sessionId)?.() : undefined),
			});
		};
		this.getPermissionBridge = () => (getPermissionBridge() ? namedBridge : undefined);
	}

	static async create(
		cwd: string,
		getMcpTools: () => ToolDefinition[] | Promise<ToolDefinition[]> = () => [],
		getPermissionBridge: () => PermissionBridge | undefined = () => undefined,
		getHookBridge: () => HookBridge | undefined = () => undefined,
		onExtensionError: (runName: string | undefined, error: ExtensionError) => void = () => {},
		onModelUnusable: (model: string, reason: string) => void = () => {},
		onChildWrite: (path: string, runName: string | undefined) => void = () => {},
		getParentDeferred: () => DeferRequest[] = () => [],
		getParentMode?: () => string,
		getParentLevelOwnership: () => LevelOwnership = () => ({ source: "user", launchReleased: false }),
	): Promise<SubagentRuntime> {
		const modelRuntime = await createSharedModelRuntime(getAgentDir());
		// Prime the catalog once; spawns read the live snapshot (see resolveModel).
		await modelRuntime.getAvailable();
		return new SubagentRuntime(modelRuntime, cwd, getMcpTools, getPermissionBridge, getHookBridge, onExtensionError, onModelUnusable, onChildWrite, getParentDeferred, getParentMode, getParentLevelOwnership);
	}

	/**
	 * Resolve a `provider/id` spec against the child runtime's CURRENT catalog.
	 * The parent resolved the spec against its own live registry; this runtime
	 * has a second one, and they drift (a /login mid-session, a models.json edit,
	 * a provider that appeared later). Passing an unresolved model to
	 * createAgentSession would make pi fall back to the user's SAVED DEFAULT
	 * silently — so an unknown spec throws in the shape the fallback path
	 * recognises (`isModelUnavailableError`), which reports the swap instead of
	 * hiding it (SUBAGENT-REVIEW M6).
	 */
	private async resolveModel(spec: string): Promise<Model<Api>> {
		let found = findConfigured([...this.modelRuntime.getAvailableSnapshot()], spec);
		if (!found) found = findConfigured([...(await this.modelRuntime.getAvailable())], spec);
		if (!found) throw new Error(`model ${spec} not found in the subagent runtime's catalog`);
		return found;
	}

	/**
	 * The loader options for one child session. A fork inherits the parent's
	 * system prompt (also on a RESUME of a finished fork, read from the file
	 * persisted beside its session — without it the resume ran on pi's stock
	 * prompt and default tools, review S6); a named agent carries its own; a
	 * plain run gets pi's base prompt. Built fresh per session (agent-loader.ts).
	 */
	private childLoaderOptions(spec: ChildSessionSpec, handback: HandbackSlot & TurnFailureSink, background: boolean): AgentLoaderOptions {
		// A background agent's turn fails after a stall (stall-watch.ts), timed from pi's idle timeout.
		const stallMs = background ? agentStallMs(knobValue(AGENT_STALL_KNOB), SettingsManager.create(spec.cwd, getAgentDir()).getHttpIdleTimeoutMs()) : undefined;
		const fork = SubagentRuntime.isFork(spec);
		const systemPrompt = fork ? spec.parentSystemPrompt : spec.agent?.systemPrompt;
		return {
			cwd: this.baseCwd,
			agentDir: getAgentDir(),
			systemPrompt,
			neverGate: NEVER_GATE,
			extraExtensionPaths: childExtensionPaths(),
			// Every child hands back through SubagentHandback (deferred in a fork,
			// lib/agents/subagent-handback.ts). Inline extensions load after the paths
			// above, so the fork-cache one, last, sees the final body.
			extraFactories: [
				// The tools injected below (the spawn and cron tools, the shared MCP
				// tools) are deferred as the parent defers them: their owners run there.
				deferLikeParentExtension(this.getParentDeferred(), injectedByParent(spec.extraTools ?? [])),
				// Every subagent also gets SendMessage to its caller (sendToMainTool below),
				// unless pi's tool flags removed it (lib/agents/agent-catalog.ts agentToolOptions).
				subagentHandbackExtension(handback, { deferred: fork, sendMessage: toolLive("SendMessage") }),
				// A guard that stops the child's turn (a runaway tool call) says why on the
				// child's own bus; the turn's outcome carries it to the parent's notification.
				turnFailureExtension(handback),
				...(stallMs !== undefined ? [stallWatchExtension(stallMs)] : []),
				...(fork && this.getParentMode ? [parentModeExtension(this.getParentMode)] : []),
				...(fork && spec.parentRequest ? [forkCacheExtension(spec.parentRequest, spec.parentTools)] : []),
			],
			// instructions (above) injects the CLAUDE.md instructions on the child's session_start;
			// pi must not append the same files to the system prompt as well.
			noContextFiles: true,
			getPermissionBridge: this.getPermissionBridge,
			getHookBridge: this.getHookBridge,
			agentTypeOf: (sessionId) => (sessionId ? this.agentTypes.get(sessionId) : undefined),
		};
	}

	/** A fork run, or a resume of one (its inherited prompt comes back from the persisted file). */
	private static isFork(spec: Pick<ChildSessionSpec, "forkFrom" | "parentSystemPrompt">): boolean {
		return Boolean(spec.forkFrom) || spec.parentSystemPrompt !== undefined;
	}

	/**
	 * The system-prompt identity of a run: a fork (keyed by the parent prompt it
	 * inherits, which varies turn to turn — two forks from one message share it,
	 * forks from different turns do not), a named agent, or pi's base prompt.
	 */
	private static promptKey(spec: Pick<ChildSessionSpec, "forkFrom" | "parentSystemPrompt" | "agent">): string {
		if (SubagentRuntime.isFork(spec)) {
			return `fork:${createHash("sha1").update(spec.parentSystemPrompt ?? "").digest("hex").slice(0, 16)}`;
		}
		return agentPromptIdentity(spec.agent?.name);
	}

	/**
	 * Hold a run until a sibling with the same request prefix has started
	 * streaming (see `warmGate`): same prompt identity, same cwd (the child's
	 * instructions block names its paths) and same model. Resolves to the release
	 * for the caller's `finally`.
	 */
	private admitPrefix(spec: Pick<ChildSessionSpec, "cwd" | "forkFrom" | "parentSystemPrompt" | "agent">, session: Session): Promise<Release> {
		const model = session.model;
		const key = prefixWarmKey(SubagentRuntime.promptKey(spec), spec.cwd, model ? modelSpec(model) : undefined);
		return this.warmGate.admitOnFirstToken(key, session);
	}

	/** Subscribe a turn tracker to a session, feeding progress and (optionally) turn-settle. Returns the unsubscribe. */
	private wireTracker(
		session: Session,
		tracker: SessionTurnTracker,
		onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void,
		onSettled?: () => void,
		sink?: LiveSink,
	): () => void {
		const childWrote = childWriteWatcher(session.sessionManager?.getCwd?.() ?? this.baseCwd);
		return session.subscribe((event) => {
			try {
				const settled = tracker.process(event as never);
				const wrote = childWrote(event as never);
				if (wrote) this.onChildWrite(wrote, this.runNames.get(session.sessionId));
				const e = event as { type?: string; toolName?: string; args?: unknown; isError?: boolean; result?: unknown; message?: { role?: string; content?: unknown } };
				if (e.type === "tool_execution_start") {
					sink?.onBlock?.({ kind: "call", tool: e.toolName ?? "tool", text: summarizeArgs(e.args) });
					sink?.onActivity?.(e.toolName, e.args, tracker.turnText);
				} else if (e.type === "tool_execution_end") {
					// Display only: the child's persisted reminders (file-tracker, hook context) stay with the model.
					const text = cutPlainText(
						firstNonEmptyLine(textContent(stripReminderBlocks(e.result as { content?: Array<{ type: string; text?: string }> }))),
						200,
					);
					sink?.onBlock?.({ kind: "result", tool: e.toolName ?? "tool", text: text || (e.isError ? "error" : "done"), isError: e.isError });
				} else if (e.type === "message_update" && e.message?.role === "assistant") {
					sink?.onStreaming?.(e.message);
				} else if (e.type === "message_end" && e.message?.role === "assistant") {
					sink?.onStreaming?.(undefined);
					sink?.onUsage?.((e.message as { usage?: unknown }).usage);
					// The provider refused this model for this account ("not supported
					// with a ChatGPT account", 404 on the model): the catalog offered it,
					// the account cannot run it. Tell the parent so selection skips it
					// from now on (lib/models/model-unusable.ts) — the same class of error the
					// auto-mode classifier steps over (`isModelUnavailableError`).
					const reply = e.message as { stopReason?: string; errorMessage?: string; provider?: string; model?: string };
					if (reply.stopReason === "error" && reply.errorMessage && reply.provider && reply.model && isModelUnavailableError(reply.errorMessage)) {
						this.onModelUnusable(modelSpec({ provider: reply.provider, id: reply.model }), reply.errorMessage);
					}
					const text = streamingText(e.message).trim();
					if (text) {
						sink?.onBlock?.({ kind: "text", text });
						sink?.onActivity?.(undefined, undefined, text);
					}
				}
				if (event.type === "tool_execution_start" || event.type === "message_end") {
					onProgress(tracker.toolCalls, tracker.turnText, tracker.usage);
				}
				if (settled) onSettled?.();
			} catch {
				// A bad event shape must never throw into the agent's emit loop.
			}
		});
	}

	/**
	 * Build the child session, falling back to the session model when an
	 * *automatically chosen* model cannot spawn (not entitled, withdrawn). The
	 * automatic pick is a cost optimisation we made, not a model the user or the
	 * main model named, so a broken pick must degrade to the always-working
	 * session model rather than fail the whole subagent (CC parity). A per-call
	 * model carries no `fallbackModel`, so it surfaces its error to the main model
	 * to retry — never a silent swap of a model it chose. The returned `note` is
	 * surfaced to the user/main model so the fallback is never silent.
	 *
	 * The loader is built once per call, alongside the MCP-tools wait, and is
	 * reused across the fallback attempt (a failed `createAgentSession` leaves no
	 * session, so nothing has invalidated it — agent-loader.ts); the session
	 * manager is created fresh per attempt, since one reused after a failed
	 * create could be half-initialized. Resume reopens a finished session; fork
	 * inherits the parent transcript + system prompt; a fresh named run gets the
	 * agent's own prompt and toolset.
	 */
	private async buildChildSession(spec: ChildSessionSpec, handback: HandbackSlot & TurnFailureSink, background = false): Promise<{ session: Session; note?: string }> {
		// The MCP wait first: the loader takes the parent's deferrals, which a server
		// connecting during the wait adds to (it is instant once the connects settled).
		const mcpTools = await this.getMcpTools();
		const loader = await buildAgentLoader(this.childLoaderOptions(spec, handback, background));
		const newSessionManager = () => newChildSessionManager(spec);
		// A fork keeps the parent's toolset; only a named agent carries tool lists.
		const agent = spec.forkFrom ? undefined : spec.agent;
		// pi's tool flags restrict every child (lib/agents/agent-catalog.ts agentToolOptions).
		const removed = toolsRemovedByFlags(agent);
		// Told once, when the agent starts: a resume continues a session that heard it.
		const flagsNote = removed.length > 0 && agent && !spec.sessionFile ? subagentResultText().toolsLeftOut({ name: agent.name, tools: removed }) : undefined;
		const fork = SubagentRuntime.isFork(spec);
		const ownTools = [sendToMainTool((m, s) => spec.onMessageToMain?.(m, s)), ...(spec.extraTools ?? []), ...childMcpTools(mcpTools)];
		// A fork declares the parent's schemas (fork-cache.ts) whenever it is handed the parent's
		// tools: at a spawn with its parent's request, and on every resume, so a resume whose saved
		// request is gone still declares what the fork's own recorded requests did.
		const customTools = fork && spec.parentTools ? withParentParameters(ownTools, spec.parentTools) : ownTools;
		const make = async (model: string | undefined): Promise<Session> => {
			const resolvedModel = model ? await this.resolveModel(model) : undefined;
			const sessionManager = newSessionManager();
			const session = await openChildSession({
				loader,
				session: {
					cwd: spec.cwd,
					agentDir: getAgentDir(),
					// A fork's Codex requests go out under its parent's session id, so they read the parent's cache.
					modelRuntime: fork && spec.parentRequest?.sessionId ? withParentSessionId(this.modelRuntime, spec.parentRequest.sessionId, () => sessionManager.getSessionId()) : this.modelRuntime,
					model: resolvedModel as never,
					thinkingLevel: spec.thinking as never,
					// The allowlist with the plumbing re-added, and the denylist (CC's "All
					// tools except …" shape), which filters injected customTools too.
					...agentToolOptions(agent),
					customTools,
					sessionManager,
				},
				startReason: spec.sessionFile ? "resume" : spec.forkFrom ? "fork" : "startup",
				onError: (error) => this.onExtensionError(spec.name, error),
			});
			// An allowlist that matched nothing real would run a tool-less agent
			// (pi drops unknown names silently). Fail loud with the fix named.
			const unusable = unusableAllowlistError(
				agent,
				session.getAllTools().map((t) => t.name),
			);
			if (unusable) {
				this.discard(session);
				throw new Error(unusable);
			}
			if (agent && !spec.sessionFile && spec.thinking === undefined) applyChildTierDefault(session, this.getParentLevelOwnership());
			if (spec.name) this.runNames.set(session.sessionManager.getSessionId(), spec.name);
			if (spec.agent) this.agentTypes.set(session.sessionManager.getSessionId(), spec.agent.name);
			if (spec.mainToolCallId) this.mainToolCalls.set(session.sessionManager.getSessionId(), spec.mainToolCallId);
			return session;
		};
		const withFlagsNote = (note: string | undefined) => [flagsNote, note].filter(Boolean).join("\n") || undefined;
		try {
			return { session: await make(spec.model), note: withFlagsNote(undefined) };
		} catch (error) {
			const message = (error as Error).message;
			if (spec.fallbackModel && spec.fallbackModel !== spec.model && isModelUnavailableError(message)) {
				return {
					session: await make(spec.fallbackModel),
					note: withFlagsNote(subagentResultText().modelFallback({ model: spec.model, osMessage: message, fallback: spec.fallbackModel })),
				};
			}
			throw error;
		}
	}

	/** Dispose a child session and forget its run-name mapping. */
	private discard(session: Session): void {
		this.runNames.delete(session.sessionManager.getSessionId());
		this.agentTypes.delete(session.sessionManager.getSessionId());
		this.mainToolCalls.delete(session.sessionManager.getSessionId());
		disposeChildSession(session);
	}

	/**
	 * A blocking run (nested spawn, SendMessage resume, one-shot-mode spawn): one
	 * prompt, awaited, then disposed. The caller frames a fork's task
	 * (`forkTaskMessage`) — it knows the worktree the fork may be isolated in.
	 */
	run(options: SubagentRunOptions): ChildHandle {
		const tracker = new SessionTurnTracker();
		let session: Session | undefined;

		const result: Promise<ChildOutcome> = (async () => {
			let unsubscribe: (() => void) | undefined;
			let spawnNote: string | undefined;
			// Every way this turn can be cut short marks the tracker first, so the
			// outcome read after prompt() resolves reports "terminated", never the
			// partial text as a clean completion (M3).
			const abortWith = (reason?: AbortReason) => {
				tracker.markAborted(reason);
				void session?.abort();
			};
			const unhookAbort = whenAborted(options.signal, () => abortWith());
			const wallClock = setTimeout(() => abortWith("wallClock"), WALL_CLOCK_CAP_MS);
			wallClock.unref?.();

			try {
				// Construction happens INSIDE the try: a failure here (bad model,
				// corrupt session file, loader error) must resolve to a failed
				// outcome, never reject handle.result — call sites like the
				// SendMessage resume path consume it with a bare .then().
				const built = await this.buildChildSession(options, tracker, options.background === true);
				session = built.session;
				spawnNote = built.note;
				unsubscribe = this.wireTracker(session, tracker, options.onProgress, undefined, options.sink);
				// A resume continues a unique history; only a fresh run shares a prefix.
				const releasePrefix = options.sessionFile ? undefined : await this.admitPrefix(options, session);
				try {
					// abort() is a no-op before the prompt starts. Every cancellation
					// source (signal, kill, wall-clock cap) marks the tracker first,
					// including one that landed during construction or the prefix wait.
					if (tracker.aborted) throw new Error("cancelled before the first request was sent");
					// No template/command expansion: a task starting with "/" is text, not
					// a command lookup (pi's own sendUserMessage does the same — L2).
					await session.prompt(options.task, { expandPromptTemplates: false });
				} finally {
					releasePrefix?.(false);
				}
				return withNote(tracker.turnOutcome(), spawnNote);
			} catch (error) {
				// Keep the fallback note if the model was swapped before the turn failed.
				return withNote(
					{ output: subagentResultText().failure({ kind: "failed", osMessage: (error as Error).message }), toolCalls: tracker.toolCalls, usage: tracker.usage, actions: tracker.actions, failed: true },
					spawnNote,
				);
			} finally {
				clearTimeout(wallClock);
				unhookAbort();
				unsubscribe?.();
				if (session) this.discard(session);
			}
		})();

		return {
			result,
			kill: () => {
				// A run pi has already ended finished on its own: prompt() is only
				// waiting on the settle handlers, so its outcome stays the real one.
				if (!settledInPi(tracker, session)) tracker.markAborted();
				void session?.abort();
			},
			snapshot: () => ({ toolCalls: tracker.toolCalls, text: tracker.turnText, usage: tracker.usage }),
		};
	}

	/**
	 * A resident session that stays alive after its first turn so SendMessage can
	 * reach it live: steer into a running turn, or start a new turn when idle. The
	 * in-process reentrancy of AgentSession.prompt()/steer() removes the boot-lag
	 * buffering the spawned RPC child needed. The initial task is delivered by the
	 * caller via `send()` (fork runs wrap it with forkTaskMessage first). Each turn
	 * carries its own wall-clock cap so a hung turn can't tie up the loop forever,
	 * while an idle resident lives until task_stop / session shutdown.
	 */
	async runResident(options: ResidentRunOptions): Promise<RpcChildHandle> {
		const tracker = new SessionTurnTracker();
		const built = await this.buildChildSession(options, tracker, true);
		const session = built.session;
		let spawnNote = built.note;
		let exited = false;
		let exitPromise: Promise<void> | undefined;
		let turnActive = false;
		let firstTurn = true;
		let turnTimer: ReturnType<typeof setTimeout> | undefined;
		const clearTurnCap = () => {
			if (turnTimer) clearTimeout(turnTimer);
			turnTimer = undefined;
		};
		/** Deliver a turn's outcome exactly once, whether it settled normally or the turn failed to run. */
		const finishTurn = (outcome: ChildOutcome) => {
			if (!turnActive) return;
			turnActive = false;
			clearTurnCap();
			// Surface a one-time model-fallback note on the first turn that reports.
			options.onTurnEnd(withNote(outcome, spawnNote));
			spawnNote = undefined;
		};

		// On settle: report the turn, then dispatch a message held over the settle
		// window (pendingSend below). The dispatch runs on the settle EVENT, not
		// inside finishTurn, because a capped turn reports early from its timer
		// while the session is still aborting — the next turn must not start
		// until the session is really idle.
		this.wireTracker(
			session,
			tracker,
			options.onProgress,
			() => {
				finishTurn(tracker.turnOutcome());
				releasePending();
			},
			options.sink,
		);
		// `this` inside the handle's methods is the handle, so bind these here.
		const admitPrefix = () => this.admitPrefix(options, session);
		const discard = () => this.discard(session);

		/**
		 * A message that arrived in the settle window: pi has already cleared
		 * `_isAgentRunActive` (so `session.isIdle` is true) but our subscribe
		 * listener has not yet run `finishTurn` for the turn that just ended. Starting
		 * a turn there would reset the tracker under the unreported outcome, and
		 * steering would queue against an idle agent (delivered only with the NEXT
		 * prompt while the tool result claimed "steered"). Instead the message is held
		 * and dispatched by finishTurn as the next turn (SUBAGENT-REVIEW L6).
		 */
		let pendingSend: string | undefined;
		const startTurn = (message: string): void => {
			tracker.beginTurn();
			turnActive = true;
			options.onTurnStart?.();
			// The cap measures the turn's own work, so it is armed when the prompt
			// actually starts — after any wait behind the prefix gate.
			const armTurnCap = () => {
				clearTurnCap();
				turnTimer = setTimeout(() => {
					// Same rationale as kill(): the abort settles through the normal
					// turn path, which would report the capped turn as a completion.
					tracker.markAborted("wallClock");
					finishTurn(tracker.turnOutcome());
					void session.abort();
				}, WALL_CLOCK_CAP_MS);
				turnTimer.unref?.();
			};
			// No template/command expansion: a task starting with "/" is text (L2).
			const prompt = () => session.prompt(message, { expandPromptTemplates: false });
			// The first turn waits for a sibling with the same prefix to start
			// streaming (admitPrefix); later turns continue a unique history.
			let prompting: Promise<void>;
			if (firstTurn) {
				prompting = admitPrefix().then((release) => {
					// kill() may have aborted and disposed the session while this
					// turn was queued behind the gate; prompting it now would fail
					// silently (finishTurn already ran). Hand the lead on instead.
					if (exited) {
						release(false);
						return;
					}
					armTurnCap();
					return prompt().finally(() => release(false));
				});
			} else {
				armTurnCap();
				prompting = prompt();
			}
			firstTurn = false;
			// A prompt that can't even start (no API key, bad model) rejects; surface
			// it as a failed turn instead of leaving the caller waiting forever.
			void prompting.catch((error) => {
				finishTurn({
					output: subagentResultText().failure({ kind: "turnNotStarted", osMessage: (error as Error).message }),
					toolCalls: tracker.toolCalls,
					usage: tracker.usage,
					actions: tracker.actions,
					failed: true,
				});
			});
		};
		const releasePending = () => {
			if (pendingSend === undefined || exited || turnActive || !session.isIdle) return;
			const message = pendingSend;
			pendingSend = undefined;
			startTurn(message);
		};

		return {
			async send(message: string): Promise<"started" | "steered"> {
				// Gate on our own synchronous turnActive flag, not session.isIdle alone:
				// isIdle only flips deep inside prompt() after real awaits, so two rapid
				// sends could both see an idle session and issue concurrent prompts.
				if (!turnActive && session.isIdle) {
					startTurn(message);
					return "started";
				}
				if (turnActive && session.isIdle) {
					// Settle window (see pendingSend). Only one message can ride it; a
					// second one joins the held one as the same next turn.
					pendingSend = pendingSend === undefined ? message : `${pendingSend}\n\n${message}`;
					return "started";
				}
				// Mid-turn: joins the running turn. pi refuses to queue an extension
				// command; the rejection reaches the caller instead of being swallowed.
				await session.steer(message);
				return "steered";
			},
			// The background extension is not loaded in a child, so the parent's
			// cron fires record what they sent straight into the child's session.
			conversation: {
				getBranch: () => session.sessionManager.getBranch(),
				appendEntry: (customType, data) => {
					session.sessionManager.appendCustomEntry(customType, data);
				},
			},
			busy: () => turnActive || !session.isIdle,
			exited: () => exited,
			kill: () => {
				if (exited) return exitPromise ?? Promise.resolve();
				exited = true;
				pendingSend = undefined;
				// Report an in-flight turn as terminated, not as a normal completion:
				// the settle path can't tell an abort's partial text from success, so
				// without this a killed run notifies as if it finished cleanly. A turn
				// pi has already ended (its settle event not yet here) finished on its
				// own, and is reported as it ended: the kill cut nothing short.
				if (!settledInPi(tracker, session)) tracker.markAborted();
				finishTurn(tracker.turnOutcome());
				// onExit only after the abort settles: it triggers worktree cleanup,
				// which must not race an aborting session still writing files. The
				// returned promise settles after that cleanup too, so session_shutdown
				// waits for exactly that.
				return (exitPromise = session
					.abort()
					.catch(() => undefined)
					.then(async () => {
						discard();
						await Promise.resolve(options.onExit?.()).catch(() => undefined);
					}));
			},
			release: () => {
				if (exited || turnActive || !session.isIdle) return;
				exited = true;
				discard();
				options.onExit?.();
			},
			snapshot: () => {
				const text =
					!session.isIdle && tracker.turnText
						? tracker.transcript
							? `${tracker.transcript}\n\n---\n\n${tracker.turnText}`
							: tracker.turnText
						: tracker.transcript || tracker.turnText;
				return { toolCalls: tracker.toolCalls, text, usage: tracker.usage };
			},
		};
	}
}
