/**
 * Host-side script globals (pure, dependency-injected). The script itself runs
 * in a worker thread (`script-worker.mjs`, launched by `vm-runtime.ts`); what
 * reaches the host over RPC is built here around one injected AgentCallFn —
 * agent()/workflow() calls, phase/log notices, args and the budget snapshot —
 * so the orchestration semantics that matter for replay and safety
 * (concurrency, caps, budget admission, null-on-failure, journal replay) are
 * unit-testable with a fake agent runner. parallel()/pipeline()/console live
 * in the worker: they take callbacks, which cannot cross the RPC boundary.
 *
 * Claude Code semantics implemented here:
 * - agent() resolves null when the underlying agent fails; caps/budget/abort
 *   violations throw (they must unwind the script).
 * - callIndex is assigned synchronously at invocation time, which is what
 *   makes journal replay deterministic under parallel().
 */

import { hashAgentCall } from "./journal.ts";
import { previewValue } from "./records.ts";
import type {
	AgentCallFn,
	AgentCallOptions,
	AgentRunUpdate,
	BudgetSnapshot,
	JournalEntry,
	RunProgressEvent,
} from "./types.ts";
import { WorkflowScriptError } from "./types.ts";
import type { ReplayCursor } from "./journal.ts";

export const MAX_AGENTS_PER_RUN = 1000;
export const MAX_ITEMS_PER_CALL = 4096;
export const MAX_CONCURRENCY = 16;
/** log()/phase() notices a script may emit between two worker heartbeats (25 ms) before it is judged a flood. */
export const MAX_NOTICES_PER_TICK = 10_000;

/** Promise-queue limiter: at most `limit` callbacks in flight, FIFO overflow. */
export function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const queue: Array<() => void> = [];
	const release = () => {
		active--;
		queue.shift()?.();
	};
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
		active++;
		try {
			return await fn();
		} finally {
			release();
		}
	};
}

/**
 * One run tree's admission controls and totals: the budget snapshot, the
 * concurrency limiter, the agent cap and the counters they read. Created ONCE
 * per run (`createRunAdmission`) and shared by every nested workflow(), so a
 * child's agents queue behind the same limiter, spend the same budget and
 * count against the same cap as the root's — a per-child copy taken at spawn
 * could not see the parent's later spend and let a tree exceed the run's
 * concurrency (review S9).
 */
export interface RunAdmission {
	budget: BudgetSnapshot;
	limit: ReturnType<typeof createLimiter>;
	maxAgents: number;
	agentCount: () => number;
	outputTokens: () => number;
	cost: () => number;
	account: (delta: { agents?: number; outputTokens?: number; cost?: number }) => void;
}

export interface RunAdmissionOptions {
	/** null = no budget target. */
	budgetTotal: number | null;
	concurrency: number;
	maxAgents?: number;
}

export function createRunAdmission(options: RunAdmissionOptions): RunAdmission {
	const total = options.budgetTotal;
	let agents = 0;
	let outputTokens = 0;
	let cost = 0;
	return {
		budget: Object.freeze({
			total,
			spent: () => outputTokens,
			remaining: () => (total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - outputTokens)),
		}),
		limit: createLimiter(Math.max(1, Math.min(options.concurrency, MAX_CONCURRENCY))),
		maxAgents: options.maxAgents ?? MAX_AGENTS_PER_RUN,
		agentCount: () => agents,
		outputTokens: () => outputTokens,
		cost: () => cost,
		account: (delta) => {
			agents += delta.agents ?? 0;
			outputTokens += delta.outputTokens ?? 0;
			cost += delta.cost ?? 0;
		},
	};
}

export interface ScriptGlobalsOptions {
	agentCall: AgentCallFn;
	args: unknown;
	/** The run tree's shared controls — the root's own, or inherited by a nested workflow(). */
	admission: RunAdmission;
	signal: AbortSignal;
	onEvent: (event: RunProgressEvent) => void;
	onJournal?: (entry: JournalEntry) => void;
	replay?: ReplayCursor;
	/** Wired for top-level runs only; nested workflow() calls get none (one level of nesting). */
	runWorkflow?: (nameOrRef: unknown, childArgs: unknown) => Promise<unknown>;
	/** Injected clock for journal timestamps (the vm blocks Date.now, the host doesn't). */
	now?: () => number;
}

export interface ScriptGlobals {
	agent: (prompt: string, opts?: AgentCallOptions) => Promise<unknown>;
	workflow: (nameOrRef: unknown, childArgs?: unknown) => Promise<unknown>;
	phase: (title: string) => void;
	log: (message: unknown) => void;
	args: unknown;
	budget: BudgetSnapshot;
}

/** What the run manager reads back: tree-wide totals plus this script's phase. */
export interface ScriptRunState {
	admission: RunAdmission;
	agentCount: () => number;
	outputTokens: () => number;
	cost: () => number;
	currentPhase: () => string | undefined;
}

export function createScriptGlobals(options: ScriptGlobalsOptions): { globals: ScriptGlobals; state: ScriptRunState } {
	const { admission } = options;
	const { budget, limit: limiter } = admission;
	const now = options.now ?? (() => Date.now());

	let callSeq = 0;
	let currentPhase: string | undefined;

	const throwIfAborted = () => {
		if (options.signal.aborted) throw new WorkflowScriptError("Workflow run was aborted");
	};
	const checkBudget = () => {
		if (budget.total !== null && budget.remaining() <= 0) {
			throw new WorkflowScriptError(`Workflow token budget exhausted (${budget.total} output tokens)`);
		}
	};

	const agent = async (prompt: string, opts: AgentCallOptions = {}): Promise<unknown> => {
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new WorkflowScriptError("agent() needs a non-empty prompt string");
		}
		if (opts.schema !== undefined && (typeof opts.schema !== "object" || opts.schema === null)) {
			throw new WorkflowScriptError("agent() schema must be a JSON Schema object");
		}
		throwIfAborted();
		if (admission.agentCount() >= admission.maxAgents) {
			throw new WorkflowScriptError(`Workflow agent limit reached (${admission.maxAgents} agents per run)`);
		}
		checkBudget();

		// Everything up to here — and the index/hash/phase capture — is
		// synchronous, so invocation order fully determines replay identity.
		const callIndex = callSeq++;
		admission.account({ agents: 1 });
		const hash = hashAgentCall(prompt, opts);
		const phase = opts.phase ?? currentPhase;
		const label = opts.label ?? `agent ${callIndex + 1}`;

		const replayed = options.replay?.match(callIndex, hash);
		if (replayed !== undefined) {
			admission.account({ outputTokens: replayed.tokens?.output ?? 0, cost: replayed.cost ?? 0 });
			options.onEvent({
				type: "agentEnd",
				callIndex,
				label,
				phase,
				tokens: replayed.tokens,
				replayed: true,
				prompt,
				preview: previewValue(replayed.value),
			});
			return replayed.value;
		}

		return limiter(async () => {
			// Queued calls were admitted before earlier agents reported usage.
			// Recheck here, before any provider work or agentStart event — and
			// give the admission slot back, since this agent never runs.
			try {
				throwIfAborted();
				checkBudget();
			} catch (error) {
				admission.account({ agents: -1 });
				throw error;
			}
			options.onEvent({ type: "agentStart", callIndex, label, phase, prompt });
			try {
				const onUpdate = (update: AgentRunUpdate) =>
					options.onEvent({ type: "agentUpdate", callIndex, label, phase, ...update });
				const result = await options.agentCall(prompt, opts, onUpdate);
				admission.account({ outputTokens: result.tokens.output, cost: result.cost });
				options.onJournal?.({ callIndex, hash, result, timestamp: now() });
				options.onEvent({
					type: "agentEnd",
					callIndex,
					label,
					phase,
					tokens: result.tokens,
					cost: result.cost,
					preview: previewValue(result.value),
				});
				return result.value;
			} catch (error) {
				if (options.signal.aborted) {
					// Close the record: the viewer would otherwise show a completed or
					// stopped run with this agent still "running".
					options.onEvent({ type: "agentEnd", callIndex, label, phase, text: "aborted" });
					throw new WorkflowScriptError("Workflow run was aborted");
				}
				// A script-authoring mistake (bad agentType/model, worktree without a
				// git repo, malformed schema) must unwind the script, not vanish into
				// a null the way a genuine agent failure does — same rule parallel()
				// and pipeline() already apply. Otherwise a completed run reports a
				// null hole with the real cause nowhere in the final report.
				if (error instanceof WorkflowScriptError) throw error;
				// A failed agent resolves to null (Claude Code semantics); the
				// failure is surfaced as a progress event, not an exception.
				options.onEvent({ type: "agentEnd", callIndex, label, phase, text: `failed: ${(error as Error).message}` });
				return null;
			}
		});
	};

	const workflowFn = async (nameOrRef: unknown, childArgs?: unknown): Promise<unknown> => {
		if (!options.runWorkflow) {
			throw new WorkflowScriptError("workflow() nesting is one level only — this run cannot start another child workflow");
		}
		return options.runWorkflow(nameOrRef, childArgs);
	};

	const log = (message: unknown) => {
		options.onEvent({ type: "log", text: String(message) });
	};

	const globals: ScriptGlobals = {
		agent,
		workflow: workflowFn,
		phase: (title: string) => {
			currentPhase = String(title);
			options.onEvent({ type: "phase", phase: currentPhase });
		},
		log,
		args: options.args,
		budget,
	};

	const state: ScriptRunState = {
		admission,
		agentCount: admission.agentCount,
		outputTokens: admission.outputTokens,
		cost: admission.cost,
		currentPhase: () => currentPhase,
	};

	return { globals, state };
}
