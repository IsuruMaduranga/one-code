/** Plain JS so workers work in the packaged app without pi's TypeScript loader. */
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

class WorkflowScriptError extends Error {}
const pending = new Map();
let sequence = 0;
let notices = 0;
const send = (message) => parentPort.postMessage(message);
// Shared with the host (vm-runtime.ts): [0] output tokens spent, [1] heartbeat.
const shared = new BigInt64Array(workerData.shared);
const SLOT_SPENT = 0;
const SLOT_HEARTBEAT = 1;
const budget = Object.freeze({
	total: workerData.total,
	spent: () => Number(Atomics.load(shared, SLOT_SPENT)),
	remaining: () => workerData.total === null ? Infinity : Math.max(0, workerData.total - Number(Atomics.load(shared, SLOT_SPENT))),
});

function call(method, args) {
	if (pending.size >= workerData.maxPending) {
		return Promise.reject(new WorkflowScriptError(`Workflow agent limit reached (${workerData.maxPending} agent()/workflow() calls in flight per run)`));
	}
	const id = sequence++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		try { send({ type: "call", id, method, args }); }
		catch (error) { pending.delete(id); reject(new WorkflowScriptError(error.message)); }
	});
}

parentPort.on("message", ({ id, value, error }) => {
	const request = pending.get(id);
	if (!request) return;
	pending.delete(id);
	if (error) request.reject(error.fatal ? new WorkflowScriptError(error.message) : new Error(error.message));
	else request.resolve(value);
});

// Callback combinators must stay in the script thread: functions cannot cross
// the RPC boundary. Fatal admission errors retain their identity across RPC.
async function parallel(thunks) {
	if (!Array.isArray(thunks)) throw new WorkflowScriptError("parallel() takes an array of functions");
	if (thunks.length > workerData.maxItems) throw new WorkflowScriptError(`parallel() accepts at most ${workerData.maxItems} items (got ${thunks.length})`);
	const settled = await Promise.allSettled(thunks.map((thunk) => {
		try {
			if (typeof thunk !== "function") throw new WorkflowScriptError("parallel() items must be functions returning promises");
			return Promise.resolve(thunk());
		} catch (error) { return Promise.reject(error); }
	}));
	return settled.map((result) => {
		if (result.status === "fulfilled") return result.value;
		if (result.reason instanceof WorkflowScriptError) throw result.reason;
		return null;
	});
}

async function pipeline(items, ...stages) {
	if (!Array.isArray(items)) throw new WorkflowScriptError("pipeline() takes an array of items");
	if (items.length > workerData.maxItems) throw new WorkflowScriptError(`pipeline() accepts at most ${workerData.maxItems} items (got ${items.length})`);
	if (stages.some((stage) => typeof stage !== "function")) throw new WorkflowScriptError("pipeline() stages must be functions");
	return Promise.all(items.map(async (item, index) => {
		let prev = item;
		for (const stage of stages) {
			try { prev = await stage(prev, item, index); }
			catch (error) {
				if (error instanceof WorkflowScriptError) throw error;
				return null;
			}
		}
		return prev;
	}));
}

function notice(type, value) {
	// Bound message traffic if a script loops around synchronous log/phase.
	if (++notices > workerData.maxNotices) {
		throw new WorkflowScriptError(`Too many workflow progress messages without yielding (${workerData.maxNotices} log()/phase() calls between two heartbeats)`);
	}
	send({ type, value: String(value) });
}
const log = (value) => notice("log", value);
const globals = {
	agent: (prompt, opts) => call("agent", [prompt, opts]),
	workflow: (ref, args) => call("workflow", [ref, args]),
	parallel, pipeline,
	phase: (title) => notice("phase", title),
	log,
	console: { log, info: log, warn: (value) => log(`[warn] ${String(value)}`), error: (value) => log(`[error] ${String(value)}`) },
	args: workerData.args,
	budget,
};

// A busy loop or microtask spin starves this timer, so the counter stops.
const heartbeat = setInterval(() => { notices = 0; Atomics.add(shared, SLOT_HEARTBEAT, 1n); }, 25);
// First beat before the script runs: from here on the host applies the script
// timeout, not the startup grace — a script that spins from its first line is
// caught just like one that spins after an await.
Atomics.add(shared, SLOT_HEARTBEAT, 1n);
try {
	const context = vm.createContext({ __workflow__: globals }, { codeGeneration: { strings: false, wasm: false } });
	const script = new vm.Script(workerData.source, { filename: workerData.filename });
	const value = await script.runInContext(context);
	send({ type: "result", value });
} catch (error) {
	send({ type: "error", message: error?.message ?? String(error) });
} finally {
	clearInterval(heartbeat);
	parentPort.close();
}
