/**
 * In-process subagent execution — the one place the workflow extension
 * touches pi's SDK. Each agent() call becomes a real agent session with an
 * in-memory session file; the run shares a single ModelRuntime across all its
 * agents (building one per agent is expensive). The resource loader is NOT
 * shared: disposing one session on a loader invalidates the loader's runtime
 * for every other session built on it (lib/agent-loader.ts, LIFECYCLE-REVIEW
 * H3), so each agent() call opens its own through `openChildSession`, which
 * also emits the `session_start` pi's SDK never sends (H2).
 *
 * Each loader uses `noExtensions: true`, which structurally blocks recursive
 * orchestration (no workflow tool inside subagents) — and would also drop One
 * Code's permission gate, so `permissionGateFactory` is passed via
 * `extensionFactories`, which DefaultResourceLoader always loads.
 */

import os from "node:os";
import { getAgentDir, type ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { whenAborted } from "../lib/abort.ts";
import { createSharedModelRuntime, finalAssistantText, openChildSession } from "../lib/agent-loader.ts";
import { modelSpec as modelSpecOf, supportsImageInput } from "../lib/model-policy.ts";
import { isModelUnavailableError } from "../auto-mode/model-select.ts";
import { agentPromptIdentity, PrefixWarmGate, prefixWarmKey } from "../lib/prefix-warm-gate.ts";
import type { PermissionBridge } from "../permissions/subagent-gate.ts";
import { localGateMode, MODE_ENV } from "../lib/permission-gate.ts";
import type { HookBridge } from "../hooks/subagent-bridge.ts";
import { summarizeArgs } from "../lib/tui-render.ts";
import { agentDirs, type AgentDefinition, discoverAgents } from "../subagents/agents.ts";
import type { SubagentDefault } from "../subagents/default-model.ts";
import { expensiveModelGate, resolveSubagentModel, subagentModelMenu } from "../subagents/model-select.ts";
import { withoutUnusable } from "../lib/model-unusable.ts";
import { cleanupWorktree, createWorktree, isGitRepo, type Worktree } from "../subagents/worktree.ts";
import type { AgentCallOptions, AgentCallResult, AgentEffort, AgentRunUpdate } from "./types.ts";
import { WorkflowScriptError } from "./types.ts";

const MAX_SCHEMA_RETRIES = 2;
const OUTPUT_CAP = 50_000;

export interface AgentRunnerOptions {
	cwd: string;
	/** Session model, retained as the final fallback. */
	defaultModel: unknown;
	/** `/subagent` user/managed default (with its staleness stamp); automatic role selection follows it. */
	configuredDefault?: SubagentDefault;
	defaultEffort?: AgentEffort | string;
	/** Surface model-resolution notices (fallbacks, provider crossings) in the run log. */
	onNotice?: (message: string) => void;
	/** Models this account cannot run (`provider/id`), learned this session — dropped from the catalog before resolving (lib/model-unusable.ts). */
	unusableModels?: () => ReadonlySet<string>;
	/** An agent's provider refused its model as not usable on this account (`isModelUnavailableError`): report it so every picker skips it. */
	onModelUnusable?: (model: string, reason: string) => void;
	/**
	 * The parent permissions extension's decision closure (same bridge the
	 * subagent runner uses): when present, a workflow agent's tool calls route
	 * through the parent's real permission pipeline — mode inheritance, the
	 * auto-mode classifier, prompts bubbled to the user. Without it the child
	 * gate falls back to fail-closed local rules, which deny every bash call
	 * that would normally ask — unusable outside auto/bypass modes.
	 */
	getPermissionBridge?: () => PermissionBridge | undefined;
	/** The parent hooks extension's bridge, so the user's tool hooks run for workflow agents too. */
	getHookBridge?: () => HookBridge | undefined;
	/** Each finished agent's dollar cost (review S13: workflow agents never reached the footer). */
	onUsage?: (cost: number) => void;
}

/**
 * Judge one `agent()` prompt as a delegation before the child starts — the
 * same `Agent` check the main conversation's spawns and a subagent's nested
 * spawns go through (matcher DELEGATION_TOOLS; subagents/index.ts). The one
 * `workflow` call was classified when the script was submitted, but every
 * prompt is computed inside the vm afterwards, often from an earlier agent's
 * output, and until 2026-09-05 none of them was judged
 * (PERMISSIONS-REVIEW-2026-09-05 L4). Outside auto mode the bridge allows at
 * once (Agent is auto-allowed there unless a deny rule names it). Without a
 * bridge — no publishing parent — the run is allowed unless the live mode is
 * auto, whose classifier is only reachable through the parent; then it fails
 * closed. A refusal is thrown as a plain Error, i.e. an agent failure (the
 * call resolves null, CC semantics), not a WorkflowScriptError: the script's
 * other agents still run.
 */
export async function judgeWorkflowDelegation(input: {
	bridge: PermissionBridge | undefined;
	liveMode: string;
	prompt: string;
	agentType?: string;
	label?: string;
	cwd: string;
	signal?: AbortSignal;
}): Promise<void> {
	if (!input.bridge) {
		if (input.liveMode === "auto") {
			throw new Error(
				"agent() refused: auto mode's classifier is only reachable through the parent session, which this run has no link to",
			);
		}
		return;
	}
	const verdict = await input.bridge({
		toolName: "Agent",
		input: { subagent_type: input.agentType, prompt: input.prompt, description: input.label },
		cwd: input.cwd,
		signal: input.signal,
	});
	if (verdict?.block) throw new Error(`agent() refused by the permission gate: ${verdict.reason}`);
}

/**
 * Shared per-run spawn state. Create once per workflow run, `dispose()` when
 * the run ends.
 */
const THINKING_SUFFIX = /^(off|minimal|low|medium|high|xhigh|max)$/i;

export interface WorkflowModelInput {
	opts: AgentCallOptions;
	agentModel?: string;
	configuredDefault?: SubagentDefault;
	sessionModel?: Model<Api>;
	available: Model<Api>[];
	defaultEffort?: string;
}

/** Pure workflow-facing wrapper around the shared subagent resolver. */
export function resolveWorkflowAgentModel(input: WorkflowModelInput): {
	model?: Model<Api>;
	thinkingLevel: string | undefined;
	notices: string[];
} {
	let requested = input.opts.model;
	let suffixLevel: string | undefined;
	if (requested) {
		const colon = requested.lastIndexOf(":");
		if (colon > 0 && THINKING_SUFFIX.test(requested.slice(colon + 1))) {
			suffixLevel = requested.slice(colon + 1).toLowerCase();
			requested = requested.slice(0, colon);
		}
	}

	const resolution = resolveSubagentModel({
		requested,
		agentModel: input.agentModel,
		configuredDefault: input.configuredDefault,
		sessionModel: input.sessionModel,
		available: input.available,
		requireImageInput: supportsImageInput(input.sessionModel),
	});
	if (resolution.unresolved) {
		const fallback = resolveSubagentModel({
			configuredDefault: input.configuredDefault,
			sessionModel: input.sessionModel,
			available: input.available,
			requireImageInput: supportsImageInput(input.sessionModel),
		});
		const menu = subagentModelMenu({
			available: input.available,
			sessionModel: input.sessionModel,
			defaultModel: fallback.model,
			defaultSource: fallback.source,
		});
		const reason = resolution.unresolvedReason ?? `agent() model "${resolution.unresolved}" is not available.`;
		throw new WorkflowScriptError(`${reason}\n${menu.join("\n")}\nAny exact provider/model-id also resolves.`);
	}
	const gate = expensiveModelGate(resolution, input.sessionModel, input.opts.allowExpensive);
	if (gate) {
		throw new WorkflowScriptError(
			`${gate}\nIf the user explicitly asked for this model, pass allowExpensive: true; otherwise pick a cheaper model or omit opts.model.`,
		);
	}
	return {
		model: resolution.model,
		thinkingLevel: input.opts.effort ?? suffixLevel ?? input.defaultEffort,
		notices: resolution.notices,
	};
}

export class AgentRunner {
	private readonly options: AgentRunnerOptions;
	private readonly modelRuntime: ModelRuntime;
	private readonly agentCatalog: AgentDefinition[];
	private readonly availableModels: Model<Api>[];
	/**
	 * `parallel()` children of one agent type share a request prefix; the first
	 * starts streaming before the rest go, so the fan-out writes the prefix once
	 * and reads it N-1 times (lib/prefix-warm-gate.ts).
	 */
	private readonly warmGate = new PrefixWarmGate();

	private constructor(options: AgentRunnerOptions, modelRuntime: ModelRuntime, agentCatalog: AgentDefinition[], availableModels: Model<Api>[]) {
		this.options = options;
		this.modelRuntime = modelRuntime;
		this.agentCatalog = agentCatalog;
		this.availableModels = availableModels;
	}

	static async create(options: AgentRunnerOptions): Promise<AgentRunner> {
		const agentDir = getAgentDir();
		const modelRuntime = await createSharedModelRuntime(agentDir);
		const agentCatalog = discoverAgents(agentDirs(options.cwd, os.homedir()));
		const availableModels = [...(await modelRuntime.getAvailable())];
		return new AgentRunner(options, modelRuntime, agentCatalog, availableModels);
	}

	/**
	 * Same resolution the subagent tool uses (see subagents/model-select.ts):
	 * aliases stay within the session's provider/vendor, exact references
	 * resolve anywhere but a provider crossing is logged, and pi's cross-provider
	 * fuzzy matcher is never consulted. A trailing ":level" effort suffix
	 * (pi's `--model sonnet:high` convention) is honoured before resolving.
	 */
	private resolveModel(opts: AgentCallOptions, agentModel?: string): { model: unknown; thinkingLevel: string | undefined } {
		const resolution = resolveWorkflowAgentModel({
			opts,
			agentModel,
			configuredDefault: this.options.configuredDefault,
			sessionModel: this.options.defaultModel as Model<Api> | undefined,
			available: withoutUnusable(this.availableModels, this.options.unusableModels?.() ?? new Set()),
			defaultEffort: this.options.defaultEffort as string | undefined,
		});
		for (const notice of resolution.notices) this.options.onNotice?.(notice);
		return { model: resolution.model ?? this.options.defaultModel, thinkingLevel: resolution.thinkingLevel };
	}

	async run(
		prompt: string,
		opts: AgentCallOptions,
		signal: AbortSignal,
		onUpdate?: (update: AgentRunUpdate) => void,
	): Promise<AgentCallResult> {
		let agentDef: AgentDefinition | undefined;
		if (opts.agentType) {
			agentDef = this.agentCatalog.find((a) => a.name === opts.agentType);
			if (!agentDef) {
				const known = this.agentCatalog.map((a) => a.name).join(", ") || "(none)";
				throw new WorkflowScriptError(`agent() agentType "${opts.agentType}" is not defined. Known agents: ${known}`);
			}
		}

		const modelSpec = this.resolveModel(opts, agentDef?.model);
		const resolvedModel = modelSpec.model as Model<Api> | undefined;
		if (resolvedModel?.id) onUpdate?.({ model: resolvedModel.id });

		await this.judgeDelegation(prompt, opts, agentDef, signal);

		let worktree: Worktree | undefined;
		let cwd = this.options.cwd;
		if (opts.isolation === "worktree") {
			if (!(await isGitRepo(this.options.cwd))) {
				throw new WorkflowScriptError('isolation: "worktree" needs a git repository');
			}
			worktree = await createWorktree(this.options.cwd, opts.label ?? "wf-agent");
			cwd = worktree.path;
		}

		const capture: { called: boolean; value: unknown } = { called: false, value: undefined };
		const customTools: ToolDefinition[] = opts.schema ? [buildStructuredOutputTool(opts.schema, capture)] : [];

		const session = await openChildSession({
			loader: {
				cwd: this.options.cwd,
				agentDir: getAgentDir(),
				systemPrompt: agentDef?.systemPrompt,
				getPermissionBridge: this.options.getPermissionBridge,
				getHookBridge: this.options.getHookBridge,
			},
			session: {
				cwd,
				agentDir: getAgentDir(),
				modelRuntime: this.modelRuntime,
				model: modelSpec.model as never,
				thinkingLevel: modelSpec.thinkingLevel as never,
				tools: agentDef?.tools,
				customTools,
				sessionManager: SessionManager.inMemory(cwd),
			},
			onError: (error) => this.options.onNotice?.(`${opts.label ?? "agent"}: extension error in ${error.event}: ${error.error}`),
		});

		const unhookAbort = whenAborted(signal, () => void session.abort());
		// Forward tool calls for the viewer's Activity pane, and report a provider
		// refusing the agent's model (the same check the subagent runner makes, so
		// the refusal reaches every automatic picker — lib/model-unusable.ts).
		// Never let a bad event shape kill the agent.
		const unsubscribe = session.subscribe((event) => {
			try {
				if (event.type === "message_end") {
					const reply = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string } }).message;
					if (reply?.role === "assistant" && reply.stopReason === "error" && reply.errorMessage && reply.provider && reply.model && isModelUnavailableError(reply.errorMessage)) {
						this.options.onModelUnusable?.(modelSpecOf({ provider: reply.provider, id: reply.model }), reply.errorMessage);
					}
					return;
				}
				if (event.type !== "tool_execution_start" || !onUpdate) return;
				try {
					const argsSummary = summarizeArgs((event as { args?: unknown }).args);
					onUpdate({ tool: { name: event.toolName, argsSummary } });
				} catch {
					onUpdate({ tool: { name: event.toolName } });
				}
			} catch {
				// observer only
			}
		});
		// Same prompt identity + cwd + model = same request prefix (see warmGate).
		const model = session.model;
		const releasePrefix = await this.warmGate.admitOnFirstToken(
			prefixWarmKey(agentPromptIdentity(agentDef?.name), cwd, model ? modelSpecOf(model) : undefined),
			session,
		);
		try {
			await session.prompt(this.buildPrompt(prompt, Boolean(opts.schema)));
			if (signal.aborted) throw new WorkflowScriptError("aborted");

			let value: unknown;
			if (opts.schema) {
				value = await this.resolveStructuredOutput(session, capture, signal);
			} else {
				value = finalAssistantText(session.messages);
				if (typeof value !== "string" || !value.trim()) {
					throw new Error("subagent produced no output");
				}
				value = (value as string).slice(0, OUTPUT_CAP);
			}

			const stats = session.getSessionStats();
			// cleanupWorktree keeps trees holding uncommitted changes; report those.
			let worktreePath: string | undefined;
			if (worktree) {
				const removed = await cleanupWorktree(this.options.cwd, worktree);
				if (!removed) worktreePath = worktree.path;
				worktree = undefined;
			}
			return {
				value,
				tokens: { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total },
				cost: stats.cost,
				worktreePath,
			};
		} finally {
			// Whatever the outcome — success, failure, or an abort (a user stop, or
			// the run finishing with this agent un-awaited) — the provider was
			// billed for what ran, so the footer's all-in cost sees it.
			const cost = session.getSessionStats().cost;
			if (cost > 0) this.options.onUsage?.(cost);
			releasePrefix(false);
			unsubscribe?.();
			unhookAbort();
			session.dispose();
			if (worktree) await cleanupWorktree(this.options.cwd, worktree);
		}
	}

	private judgeDelegation(prompt: string, opts: AgentCallOptions, agentDef: AgentDefinition | undefined, signal: AbortSignal): Promise<void> {
		return judgeWorkflowDelegation({
			bridge: this.options.getPermissionBridge?.(),
			liveMode: localGateMode(process.env[MODE_ENV], undefined),
			prompt,
			agentType: agentDef?.name,
			label: opts.label,
			cwd: this.options.cwd,
			signal,
		});
	}

	private buildPrompt(prompt: string, structured: boolean): string {
		if (!structured) {
			return `${prompt}\n\nYour final message is returned verbatim to an orchestration script, not shown to a human — reply with the requested data/report only.`;
		}
		return `${prompt}\n\nWhen you are done, you MUST call the \`structured_output\` tool exactly once with your final result. Its arguments are the only output the caller receives.`;
	}

	private async resolveStructuredOutput(
		session: { prompt(text: string): Promise<void>; messages: AgentMessage[] },
		capture: { called: boolean; value: unknown },
		signal: AbortSignal,
	): Promise<unknown> {
		for (let attempt = 0; attempt < MAX_SCHEMA_RETRIES && !capture.called; attempt++) {
			if (signal.aborted) throw new WorkflowScriptError("aborted");
			await session.prompt("You have not produced your result yet. Call the `structured_output` tool now with your final answer.");
		}
		if (capture.called) return capture.value;
		// Last resort: extract a JSON object from the final assistant text.
		const text = finalAssistantText(session.messages);
		const extracted = extractJsonObject(text);
		if (extracted !== undefined) return extracted;
		throw new Error("subagent never produced structured output");
	}

	dispose(): void {
		// The ModelRuntime holds no OS resources that need explicit teardown today
		// (each agent()'s loader dies with its session); this hook exists so
		// run-manager can stay correct if that changes.
	}
}

/** Terminating tool capturing schema-validated output (pi validates params pre-execute). */
function buildStructuredOutputTool(schema: Record<string, unknown>, capture: { called: boolean; value: unknown }): ToolDefinition {
	if (schema.type !== "object" || typeof schema.properties !== "object") {
		throw new WorkflowScriptError("agent() schema must be a JSON Schema with top-level type \"object\" and properties");
	}
	return {
		name: "structured_output",
		label: "Structured Output",
		description: "Return the final machine-readable result for this task. Call exactly once, as your last action.",
		parameters: Type.Unsafe(schema as never) as never,
		async execute(_toolCallId: string, params: unknown) {
			capture.called = true;
			capture.value = params;
			return {
				content: [{ type: "text" as const, text: "Structured output received." }],
				details: params,
				terminate: true,
			};
		},
	} as ToolDefinition;
}

/** Pull the first parseable JSON object/array out of free text (```json fences first). */
function extractJsonObject(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	const braceIndex = text.indexOf("{");
	const bracketIndex = text.indexOf("[");
	const candidates = [
		fenced?.[1],
		braceIndex >= 0 ? text.slice(braceIndex) : undefined,
		bracketIndex >= 0 ? text.slice(bracketIndex) : undefined,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			return JSON.parse(candidate.trim());
		} catch {
			// Try the next candidate form.
		}
	}
	return undefined;
}
