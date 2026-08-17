/**
 * In-process subagent execution. Replaces the per-subagent `pi` process (the
 * retired child.ts) with a real `createAgentSession()` in this process — the
 * same technique the workflow runner uses, extended with the subagent tool's
 * needs: named/persisted runs (for SendMessage resume), fork (inherit the
 * parent transcript), and the child-only SendMessage→main tool.
 *
 * One SubagentRuntime is built lazily per extension and shared across all runs:
 * a single ModelRuntime and a loader cache (building a loader re-runs every
 * curated extension factory, so each distinct system prompt is built once). Each
 * run gets its own AgentSession backed by a persisted SessionManager under
 * `<sessionDir>/subagents/<taskId>/`, so a finished run can be resumed from disk.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, getAgentDir, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildAgentLoader, createSharedModelRuntime } from "../lib/agent-loader.ts";
import type { PermissionBridge } from "../permissions/subagent-gate.ts";
import { findConfigured } from "../lib/model-policy.ts";
import type { AgentDefinition } from "./agents.ts";
import { type ChildHandle, type ChildOutcome, forkTaskMessage, type RpcChildHandle } from "./outcome.ts";
import { sendToMainTool } from "./send-to-main-tool.ts";
import { SessionTurnTracker } from "./session-turns.ts";
import type { UsageTotals } from "./usage.ts";
import type { TranscriptBlock } from "./live-runs.ts";
import { summarizeArgs, textContent } from "../lib/tui-render.ts";

/**
 * Optional live sink for the subagent panel: a one-line activity string from
 * the latest tool call, and transcript blocks (assistant text, tool calls,
 * tool results) as they stream. Purely observational — never affects the run.
 */
export interface LiveSink {
	onActivity?(toolName: string | undefined, args: unknown, lastText: string): void;
	onBlock?(block: TranscriptBlock): void;
}

/** First non-empty line of a possibly-multiline string, trimmed to `max`. */
function firstLine(text: string, max = 200): string {
	const line = text.split("\n").map((l) => l.trimEnd()).find((l) => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The assistant text of a message_end event, if any (mirrors SessionTurnTracker). */
function assistantText(message: { content?: unknown } | undefined): string {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks
		.filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text")
		.map((b) => b.text)
		.join("");
}

/** Wall-clock cap on a single run/turn — a hung session shares the main event loop. */
const WALL_CLOCK_CAP_MS = 30 * 60 * 1000;

/** Tools the runtime injects into a child; the permission gate must never gate them. */
const NEVER_GATE = new Set(["structured_output", "SendMessage"]);

/**
 * The curated extensions loaded into a subagent session (via additionalExtensionPaths,
 * which the loader loads even under noExtensions). Broadly Claude Code's model — a
 * subagent gets project context + freshness + a working toolset, but NOT the frontier
 * chrome (banner/spinner/recap) or orchestration (Agent/workflow — no recursion).
 *
 * `lsp` is deliberately NOT here (matching CC, findings §17.3): a child session is torn
 * down with the raw AgentSession.dispose(), which never fires session_shutdown, so lsp's
 * cleanup would never run and any language server it started would leak for the life of
 * the parent session (worsened by the shared loader cache). MCP is also not listed: its
 * tools are shared in from the parent as customTools (getMcpTools), not reconnected.
 *
 * Order mirrors the package's load order: reminder/deferral sinks (system-reminder,
 * tool-search) first, before anything emitting on their channels (the bus does not replay).
 */
const EXTENSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_EXTENSIONS = ["system-reminder", "tool-search", "claude-context", "file-tracker", "search-tools", "skill", "web", "web-fetch", "notebook"];
const CHILD_EXTENSION_PATHS = CHILD_EXTENSIONS.map((name) => join(EXTENSIONS_DIR, name, "index.ts"));

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Loader = Awaited<ReturnType<typeof buildAgentLoader>>;

/** The fields buildChildSession needs — the common subset of a foreground and a resident run. */
interface ChildSessionSpec {
	cwd: string;
	agent?: AgentDefinition;
	/** Parent session file — present for a fork run (inherit the parent transcript). */
	forkFrom?: string;
	/** The parent's current system prompt, applied to a fork so it continues as the parent. */
	parentSystemPrompt?: string;
	/** Existing persisted session to resume (SendMessage to a finished agent). */
	sessionFile?: string;
	/** Where a new run's persisted session lands; falls back to an in-memory session. */
	sessionDir?: string;
	/** Resolved concrete model as `provider/id` (undefined for a fork — restored from the session). */
	model?: string;
	thinking?: string;
	/** The child called SendMessage {to: "main"} — relay it to the main conversation. */
	onMessageToMain?: (message: string, summary?: string) => void;
}

export interface SubagentRunOptions extends ChildSessionSpec {
	task: string;
	signal?: AbortSignal;
	onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void;
	/** Optional live sink for the subagent panel (activity + transcript blocks). */
	sink?: LiveSink;
}

export interface ResidentRunOptions extends Omit<ChildSessionSpec, "sessionFile"> {
	onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void;
	/** Fires at the end of EVERY turn (initial task and later messages alike). */
	onTurnEnd: (outcome: ChildOutcome) => void;
	onExit?: () => void;
	/** Optional live sink for the subagent panel (activity + transcript blocks). */
	sink?: LiveSink;
}

export class SubagentRuntime {
	private readonly modelRuntime: Awaited<ReturnType<typeof createSharedModelRuntime>>;
	private readonly availableModels: Model<Api>[];
	private readonly baseCwd: string;
	/** Live MCP tools shared in from the parent session (empty when no MCP servers). */
	private readonly getMcpTools: () => ToolDefinition[];
	/** The parent's permission decision closure (undefined until permissions publishes it). */
	private readonly getPermissionBridge: () => PermissionBridge | undefined;
	/**
	 * Loader cache keyed by system-prompt identity ("base", `agent:<name>`,
	 * `fork:<prompt>`). Building one re-runs every curated extension factory plus
	 * synchronous permission-settings/git-root reads, so a repeat run on the same
	 * agent or fork prompt reuses the built loader.
	 */
	private readonly loaderCache = new Map<string, Promise<Loader>>();

	private constructor(
		modelRuntime: SubagentRuntime["modelRuntime"],
		availableModels: Model<Api>[],
		baseCwd: string,
		getMcpTools: () => ToolDefinition[],
		getPermissionBridge: () => PermissionBridge | undefined,
	) {
		this.modelRuntime = modelRuntime;
		this.availableModels = availableModels;
		this.baseCwd = baseCwd;
		this.getMcpTools = getMcpTools;
		this.getPermissionBridge = getPermissionBridge;
	}

	static async create(
		cwd: string,
		getMcpTools: () => ToolDefinition[] = () => [],
		getPermissionBridge: () => PermissionBridge | undefined = () => undefined,
	): Promise<SubagentRuntime> {
		const modelRuntime = await createSharedModelRuntime(getAgentDir());
		const availableModels = [...(await modelRuntime.getAvailable())];
		return new SubagentRuntime(modelRuntime, availableModels, cwd, getMcpTools, getPermissionBridge);
	}

	private buildChildLoader(systemPrompt?: string): Promise<Loader> {
		return buildAgentLoader({
			cwd: this.baseCwd,
			agentDir: getAgentDir(),
			systemPrompt,
			neverGate: NEVER_GATE,
			extraExtensionPaths: CHILD_EXTENSION_PATHS,
			getPermissionBridge: this.getPermissionBridge,
		});
	}

	/** Get-or-build a loader for a system-prompt identity, evicting the entry if the build fails. */
	private loaderFor(spec: ChildSessionSpec): Promise<Loader> {
		// Fork loaders are keyed by the parent's system prompt, which varies turn to
		// turn (files read, date, todo state). Caching them would grow an unbounded
		// key set and leak a full loader per distinct prompt, so a fork builds fresh.
		if (spec.forkFrom) return this.buildChildLoader(spec.parentSystemPrompt);
		const [key, systemPrompt] = spec.agent ? [`agent:${spec.agent.name}`, spec.agent.systemPrompt] : ["base", undefined];
		let pending = this.loaderCache.get(key);
		if (!pending) {
			pending = this.buildChildLoader(systemPrompt);
			pending.catch(() => this.loaderCache.delete(key));
			this.loaderCache.set(key, pending);
		}
		return pending;
	}

	/** Subscribe a turn tracker to a session, feeding progress and (optionally) turn-settle. Returns the unsubscribe. */
	private wireTracker(
		session: Session,
		tracker: SessionTurnTracker,
		onProgress: (toolCalls: number, lastText: string, usage: UsageTotals) => void,
		onSettled?: () => void,
		sink?: LiveSink,
	): () => void {
		return session.subscribe((event) => {
			try {
				const settled = tracker.process(event as never);
				const e = event as { type?: string; toolName?: string; args?: unknown; isError?: boolean; result?: unknown; message?: { role?: string; content?: unknown } };
				if (e.type === "tool_execution_start") {
					sink?.onBlock?.({ kind: "call", tool: e.toolName ?? "tool", text: summarizeArgs(e.args) });
					sink?.onActivity?.(e.toolName, e.args, tracker.turnText);
				} else if (e.type === "tool_execution_end") {
					const text = firstLine(textContent(e.result as { content?: Array<{ type: string; text?: string }> }));
					sink?.onBlock?.({ kind: "result", tool: e.toolName ?? "tool", text: text || (e.isError ? "error" : "done"), isError: e.isError });
				} else if (e.type === "message_end" && e.message?.role === "assistant") {
					const text = assistantText(e.message).trim();
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
	 * Build the child AgentSession: resume reopens a finished session; fork inherits
	 * the parent transcript + system prompt; a fresh named run gets the agent's own
	 * prompt and toolset. Shared by the foreground and resident entry points.
	 */
	private async buildChildSession(spec: ChildSessionSpec): Promise<Session> {
		const sessionManager = spec.sessionFile
			? SessionManager.open(spec.sessionFile)
			: spec.forkFrom
				? SessionManager.forkFrom(spec.forkFrom, spec.cwd, spec.sessionDir)
				: spec.sessionDir
					? SessionManager.create(spec.cwd, spec.sessionDir)
					: SessionManager.inMemory(spec.cwd);
		const loader = await this.loaderFor(spec);
		const { session } = await createAgentSession({
			cwd: spec.cwd,
			agentDir: getAgentDir(),
			modelRuntime: this.modelRuntime,
			model: (spec.model ? findConfigured(this.availableModels, spec.model) : undefined) as never,
			thinkingLevel: spec.thinking as never,
			tools: spec.forkFrom ? undefined : spec.agent?.tools,
			customTools: [sendToMainTool((m, s) => spec.onMessageToMain?.(m, s)), ...this.getMcpTools()],
			resourceLoader: loader,
			sessionManager,
		});
		return session;
	}

	/** A foreground run: one prompt, awaited, then disposed. */
	run(options: SubagentRunOptions): ChildHandle {
		const task = options.forkFrom ? forkTaskMessage(options.task) : options.task;
		const tracker = new SessionTurnTracker();
		let session: Session | undefined;

		const result: Promise<ChildOutcome> = (async () => {
			session = await this.buildChildSession(options);
			const unsubscribe = this.wireTracker(session, tracker, options.onProgress, undefined, options.sink);

			const onAbort = () => void session?.abort();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			const wallClock = setTimeout(() => void session?.abort(), WALL_CLOCK_CAP_MS);
			wallClock.unref?.();

			try {
				await session.prompt(task);
				return tracker.turnOutcome();
			} catch (error) {
				return { output: `Subagent failed: ${(error as Error).message}`, toolCalls: tracker.toolCalls, usage: tracker.usage, actions: tracker.actions, failed: true };
			} finally {
				clearTimeout(wallClock);
				options.signal?.removeEventListener("abort", onAbort);
				unsubscribe();
				session.dispose();
			}
		})();

		return {
			result,
			kill: () => void session?.abort(),
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
		const session = await this.buildChildSession(options);
		const tracker = new SessionTurnTracker();
		let exited = false;
		let turnActive = false;
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
			options.onTurnEnd(outcome);
		};

		this.wireTracker(session, tracker, options.onProgress, () => finishTurn(tracker.turnOutcome()), options.sink);

		return {
			send(message: string): "started" | "steered" {
				if (session.isIdle) {
					tracker.beginTurn();
					turnActive = true;
					clearTurnCap();
					turnTimer = setTimeout(() => void session.abort(), WALL_CLOCK_CAP_MS);
					turnTimer.unref?.();
					// A prompt that can't even start (no API key, bad model) rejects; surface
					// it as a failed turn instead of leaving the caller waiting forever.
					void session.prompt(message).catch((error) => {
						finishTurn({
							output: `Subagent could not start the turn: ${(error as Error).message}`,
							toolCalls: tracker.toolCalls,
							usage: tracker.usage,
							actions: tracker.actions,
							failed: true,
						});
					});
					return "started";
				}
				void session.steer(message).catch(() => {});
				return "steered";
			},
			busy: () => !session.isIdle,
			exited: () => exited,
			kill: () => {
				if (exited) return;
				exited = true;
				clearTurnCap();
				void session.abort().finally(() => session.dispose());
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
