/**
 * Script-visible globals (pure, dependency-injected). Everything the vm
 * script can touch — agent/parallel/pipeline/phase/log/console/args/budget —
 * is built here around one injected AgentCallFn, so the whole orchestration
 * semantics (concurrency, caps, null-on-failure, replay) is unit-testable
 * with a fake agent runner.
 *
 * Claude Code semantics implemented here:
 * - agent() resolves null when the underlying agent fails; caps/budget/abort
 *   violations throw (they must unwind the script).
 * - parallel() takes thunks, is a barrier, and maps a throwing thunk to null.
 * - pipeline() has no barrier between stages; stage callbacks receive
 *   (prev, originalItem, index); a throwing stage drops that item to null.
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

export interface ScriptGlobalsOptions {
	agentCall: AgentCallFn;
	args: unknown;
	/** null = no budget ceiling. */
	budgetTotal: number | null;
	concurrency: number;
	maxAgents?: number;
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
	parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
	pipeline: (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) => Promise<unknown[]>;
	workflow: (nameOrRef: unknown, childArgs?: unknown) => Promise<unknown>;
	phase: (title: string) => void;
	log: (message: unknown) => void;
	console: { log: (m: unknown) => void; info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void };
	args: unknown;
	budget: BudgetSnapshot;
}

export interface ScriptRunState {
	agentCount: () => number;
	outputTokens: () => number;
	cost: () => number;
	currentPhase: () => string | undefined;
}

export function createScriptGlobals(options: ScriptGlobalsOptions): { globals: ScriptGlobals; state: ScriptRunState } {
	const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
	const limiter = createLimiter(Math.max(1, Math.min(options.concurrency, MAX_CONCURRENCY)));
	const now = options.now ?? (() => Date.now());

	let callSeq = 0;
	let agentCount = 0;
	let outputTokens = 0;
	let cost = 0;
	let currentPhase: string | undefined;

	const budget: BudgetSnapshot = Object.freeze({
		total: options.budgetTotal,
		spent: () => outputTokens,
		remaining: () => (options.budgetTotal === null ? Number.POSITIVE_INFINITY : Math.max(0, options.budgetTotal - outputTokens)),
	});

	const throwIfAborted = () => {
		if (options.signal.aborted) throw new WorkflowScriptError("Workflow run was aborted");
	};

	const agent = async (prompt: string, opts: AgentCallOptions = {}): Promise<unknown> => {
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new WorkflowScriptError("agent() needs a non-empty prompt string");
		}
		if (opts.schema !== undefined && (typeof opts.schema !== "object" || opts.schema === null)) {
			throw new WorkflowScriptError("agent() schema must be a JSON Schema object");
		}
		throwIfAborted();
		if (agentCount >= maxAgents) {
			throw new WorkflowScriptError(`Workflow agent limit reached (${maxAgents} agents per run)`);
		}
		if (budget.total !== null && budget.remaining() <= 0) {
			throw new WorkflowScriptError(`Workflow token budget exhausted (${budget.total} output tokens)`);
		}

		// Everything up to here — and the index/hash/phase capture — is
		// synchronous, so invocation order fully determines replay identity.
		const callIndex = callSeq++;
		agentCount++;
		const hash = hashAgentCall(prompt, opts);
		const phase = opts.phase ?? currentPhase;
		const label = opts.label ?? `agent ${callIndex + 1}`;

		const replayed = options.replay?.match(callIndex, hash);
		if (replayed !== undefined) {
			outputTokens += replayed.tokens?.output ?? 0;
			cost += replayed.cost ?? 0;
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
			throwIfAborted();
			options.onEvent({ type: "agentStart", callIndex, label, phase, prompt });
			try {
				const onUpdate = (update: AgentRunUpdate) =>
					options.onEvent({ type: "agentUpdate", callIndex, label, phase, ...update });
				const result = await options.agentCall(prompt, opts, onUpdate);
				outputTokens += result.tokens.output;
				cost += result.cost;
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
				throwIfAborted();
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

	const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
		if (!Array.isArray(thunks)) throw new WorkflowScriptError("parallel() takes an array of functions");
		if (thunks.length > MAX_ITEMS_PER_CALL) {
			throw new WorkflowScriptError(`parallel() accepts at most ${MAX_ITEMS_PER_CALL} items (got ${thunks.length})`);
		}
		// Invoke every thunk synchronously first so agent() callIndexes are
		// assigned in array order regardless of completion timing.
		const promises = thunks.map((thunk) => {
			if (typeof thunk !== "function") {
				return Promise.reject(new WorkflowScriptError("parallel() items must be functions returning promises"));
			}
			try {
				return Promise.resolve(thunk());
			} catch (error) {
				return Promise.reject(error);
			}
		});
		const settled = await Promise.allSettled(promises);
		return settled.map((s) => {
			if (s.status === "fulfilled") return s.value;
			if (s.reason instanceof WorkflowScriptError) throw s.reason;
			return null;
		});
	};

	const pipeline = async (
		items: unknown[],
		...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>
	): Promise<unknown[]> => {
		if (!Array.isArray(items)) throw new WorkflowScriptError("pipeline() takes an array of items");
		if (items.length > MAX_ITEMS_PER_CALL) {
			throw new WorkflowScriptError(`pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items (got ${items.length})`);
		}
		if (stages.some((s) => typeof s !== "function")) {
			throw new WorkflowScriptError("pipeline() stages must be functions");
		}
		return Promise.all(
			items.map(async (item, index) => {
				let prev: unknown = item;
				for (const stage of stages) {
					try {
						prev = await stage(prev, item, index);
					} catch (error) {
						if (error instanceof WorkflowScriptError) throw error;
						return null;
					}
				}
				return prev;
			}),
		);
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
		parallel,
		pipeline,
		workflow: workflowFn,
		phase: (title: string) => {
			currentPhase = String(title);
			options.onEvent({ type: "phase", phase: currentPhase });
		},
		log,
		console: {
			log,
			info: log,
			warn: (m) => log(`[warn] ${String(m)}`),
			error: (m) => log(`[error] ${String(m)}`),
		},
		args: options.args,
		budget,
	};

	const state: ScriptRunState = {
		agentCount: () => agentCount,
		outputTokens: () => outputTokens,
		cost: () => cost,
		currentPhase: () => currentPhase,
	};

	return { globals, state };
}
