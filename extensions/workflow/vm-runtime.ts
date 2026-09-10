/**
 * Runs a parsed workflow script body in a worker thread (`script-worker.mjs`),
 * inside a `node:vm` context there. Off the TUI thread, a runaway script
 * cannot freeze pi, and the worker's heartbeat lets the host kill CPU loops
 * even after an await — which a vm `timeout` (synchronous prefix only) never
 * could. The run's signal also stops scripts that await forever.
 *
 * Only agent()/workflow() RPCs and log/phase notices reach the host, through
 * the gated globals. The vm context is a determinism guard for resume replay,
 * NOT a security sandbox: a script can reach the worker realm through the
 * prototype chain of its globals, so what it gets is the worker's process, not
 * pi's — the same class of exposure as before, one thread further away.
 */
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { MAX_AGENTS_PER_RUN, MAX_ITEMS_PER_CALL, MAX_NOTICES_PER_TICK, type ScriptGlobals } from "./globals.ts";
import { whenAborted } from "../lib/abort.ts";
import { wrapScriptBody } from "./script-source.ts";
import { WorkflowScriptError, type AgentCallOptions } from "./types.ts";

export interface WorkflowRuntimeOptions {
	signal?: AbortSignal;
	/** Maximum time without a worker heartbeat, not a timeout on agent I/O. */
	timeoutMs?: number;
}

const SLOT_SPENT = 0;
const SLOT_HEARTBEAT = 1;

type WorkerMessage =
	| { type: "result"; value: unknown }
	| { type: "error"; message: string }
	| { type: "log" | "phase"; value: string }
	| { type: "call"; id: number; method: "agent"; args: [string, AgentCallOptions?] }
	| { type: "call"; id: number; method: "workflow"; args: [unknown, unknown?] };

export async function runWorkflowScript(
	body: string,
	globals: ScriptGlobals,
	filename = "workflow.js",
	options: WorkflowRuntimeOptions = {},
): Promise<unknown> {
	if (options.signal?.aborted) throw new WorkflowScriptError("Workflow run was aborted");
	const timeoutMs = options.timeoutMs ?? 5_000;
	// Two atomic slots shared with the worker: [0] the output tokens spent so
	// far (kept current here so budget.spent()/remaining() stay synchronous in
	// scripts), [1] the worker's heartbeat counter (bumped by its own timer, so
	// a script that starves the worker's event loop stops bumping it). Atomics,
	// not messages: the host reads them on its own schedule, and a stalled host
	// loop cannot misread a healthy worker.
	const shared = new BigInt64Array(new SharedArrayBuffer(2 * BigInt64Array.BYTES_PER_ELEMENT));
	const updateBudget = () => Atomics.store(shared, SLOT_SPENT, BigInt(Math.trunc(globals.budget.spent())));
	updateBudget();
	const worker = new Worker(new URL("./script-worker.mjs", import.meta.url), {
		workerData: {
			source: wrapScriptBody(body), filename, args: globals.args,
			total: globals.budget.total, shared: shared.buffer,
			maxItems: MAX_ITEMS_PER_CALL, maxPending: MAX_AGENTS_PER_RUN, maxNotices: MAX_NOTICES_PER_TICK,
		},
		// Do not inherit CLI test/load hooks into this plain JavaScript worker.
		execArgv: [],
	});
	let watchdog: ReturnType<typeof setInterval> | undefined;
	let unhookAbort = () => {};
	try {
		return await new Promise<unknown>((resolve, reject) => {
			let stopped = false;
			let lastHeartbeat = performance.now();
			let lastBeat = 0n;
			const fail = (message: string) => {
				if (stopped) return;
				stopped = true;
				reject(new WorkflowScriptError(message));
			};
			unhookAbort = whenAborted(options.signal, () => fail("Workflow run was aborted"));
			watchdog = setInterval(() => {
				updateBudget();
				const beat = Atomics.load(shared, SLOT_HEARTBEAT);
				if (beat !== lastBeat) {
					lastBeat = beat;
					lastHeartbeat = performance.now();
				}
				// Until the first beat the worker is still starting up: allow at least 5 s.
				const allowed = lastBeat === 0n ? Math.max(5_000, timeoutMs) : timeoutMs;
				if (performance.now() - lastHeartbeat > allowed) {
					fail(`Workflow script timed out: worker was unresponsive for ${timeoutMs}ms`);
				}
			}, Math.max(10, Math.min(250, timeoutMs / 4)));
			const reply = async (message: Extract<WorkerMessage, { type: "call" }>) => {
				try {
					const value = await (message.method === "agent"
						? globals.agent(...message.args)
						: globals.workflow(...message.args));
					if (stopped) return;
					updateBudget();
					worker.postMessage({ id: message.id, value });
				} catch (error) {
					if (stopped) return;
					worker.postMessage({ id: message.id, error: {
						message: error instanceof Error ? error.message : String(error),
						fatal: error instanceof WorkflowScriptError,
					} });
				}
			};
			worker.on("message", (message: WorkerMessage) => {
				if (stopped) return;
				try {
					switch (message.type) {
						case "result": stopped = true; resolve(message.value); break;
						case "error": fail(`Workflow script failed: ${message.message}`); break;
						case "log": globals.log(message.value); break;
						case "phase": globals.phase(message.value); break;
						case "call": void reply(message).catch((error) => fail(String(error))); break;
					}
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error));
				}
			});
			worker.on("error", (error) => fail(`Workflow worker failed: ${error instanceof Error ? error.message : String(error)}`));
			worker.on("exit", (code) => fail(`Workflow worker exited before returning a result (code ${code})`));
		});
	} finally {
		clearInterval(watchdog);
		unhookAbort();
		await worker.terminate();
	}
}
