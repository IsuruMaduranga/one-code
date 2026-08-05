/**
 * In-process subagent execution — the one place the workflow extension
 * touches pi's SDK. Each agent() call becomes a real `createAgentSession()`
 * with an in-memory session; the run shares a single ModelRuntime and
 * DefaultResourceLoader across all its agents (building either per agent is
 * expensive and, for the loader, re-runs every extension factory).
 *
 * The shared loader uses `noExtensions: true`, which structurally blocks
 * recursive orchestration (no workflow tool inside subagents) — and would
 * also drop pincer's permission gate, so `permissionGateFactory` is passed
 * via `extensionFactories`, which DefaultResourceLoader always loads.
 */

import os from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { agentDirs, type AgentDefinition, discoverAgents } from "../subagents/agents.ts";
import { cleanupWorktree, createWorktree, isGitRepo, type Worktree } from "../subagents/worktree.ts";
import { permissionGateFactory } from "./permission-gate.ts";
import type { AgentCallOptions, AgentCallResult, AgentEffort } from "./types.ts";
import { WorkflowScriptError } from "./types.ts";

const MAX_SCHEMA_RETRIES = 2;
const OUTPUT_CAP = 50_000;

export interface AgentRunnerOptions {
	cwd: string;
	/** Session default model, used when a call has no model override. */
	defaultModel: unknown;
	defaultEffort?: AgentEffort | string;
}

/**
 * Shared per-run spawn state. Create once per workflow run, `dispose()` when
 * the run ends.
 */
export class AgentRunner {
	private readonly options: AgentRunnerOptions;
	private readonly modelRuntime: ModelRuntime;
	private readonly loader: DefaultResourceLoader;
	private readonly agentCatalog: AgentDefinition[];

	private constructor(
		options: AgentRunnerOptions,
		modelRuntime: ModelRuntime,
		loader: DefaultResourceLoader,
		agentCatalog: AgentDefinition[],
	) {
		this.options = options;
		this.modelRuntime = modelRuntime;
		this.loader = loader;
		this.agentCatalog = agentCatalog;
	}

	static async create(options: AgentRunnerOptions): Promise<AgentRunner> {
		const agentDir = getAgentDir();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		const loader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir,
			noExtensions: true,
			extensionFactories: [permissionGateFactory(options.cwd, os.homedir())],
		});
		await loader.reload();
		const agentCatalog = discoverAgents(agentDirs(options.cwd, os.homedir()));
		return new AgentRunner(options, modelRuntime, loader, agentCatalog);
	}

	private resolveModel(opts: AgentCallOptions): { model: unknown; thinkingLevel: string | undefined } {
		if (opts.model) {
			const resolved = resolveCliModel({ cliModel: opts.model, modelRuntime: this.modelRuntime });
			if (resolved.error || !resolved.model) {
				throw new WorkflowScriptError(`agent() model "${opts.model}" not available: ${resolved.error ?? "no match"}`);
			}
			return { model: resolved.model, thinkingLevel: opts.effort ?? resolved.thinkingLevel };
		}
		return { model: this.options.defaultModel, thinkingLevel: opts.effort ?? (this.options.defaultEffort as string | undefined) };
	}

	async run(prompt: string, opts: AgentCallOptions, signal: AbortSignal): Promise<AgentCallResult> {
		let agentDef: AgentDefinition | undefined;
		if (opts.agentType) {
			agentDef = this.agentCatalog.find((a) => a.name === opts.agentType);
			if (!agentDef) {
				const known = this.agentCatalog.map((a) => a.name).join(", ") || "(none)";
				throw new WorkflowScriptError(`agent() agentType "${opts.agentType}" is not defined. Known agents: ${known}`);
			}
		}

		const modelSpec = agentDef?.model && !opts.model ? this.resolveModel({ ...opts, model: agentDef.model }) : this.resolveModel(opts);

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

		const loader = agentDef
			? await this.loaderWithSystemPrompt(agentDef.systemPrompt)
			: this.loader;

		const { session } = await createAgentSession({
			cwd,
			agentDir: getAgentDir(),
			modelRuntime: this.modelRuntime,
			model: modelSpec.model as never,
			thinkingLevel: modelSpec.thinkingLevel as never,
			tools: agentDef?.tools,
			customTools,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
		});

		const onAbort = () => void session.abort();
		signal.addEventListener("abort", onAbort, { once: true });
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
			signal.removeEventListener("abort", onAbort);
			session.dispose();
			if (worktree) await cleanupWorktree(this.options.cwd, worktree);
		}
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

	private async loaderWithSystemPrompt(systemPrompt: string): Promise<DefaultResourceLoader> {
		const loader = new DefaultResourceLoader({
			cwd: this.options.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			extensionFactories: [permissionGateFactory(this.options.cwd, os.homedir())],
			systemPrompt,
		});
		await loader.reload();
		return loader;
	}

	dispose(): void {
		// ModelRuntime/loader hold no OS resources that need explicit teardown today;
		// this hook exists so run-manager can stay correct if that changes.
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

export function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content = (message as { content: unknown }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
				.map((b) => b.text)
				.join("");
			if (text.trim()) return text;
		}
	}
	return "";
}

/** Pull the first parseable JSON object/array out of free text (```json fences first). */
export function extractJsonObject(text: string): unknown {
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
