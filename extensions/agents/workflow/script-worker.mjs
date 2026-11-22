/** Plain JS so workers work in the packaged app without pi's TypeScript loader. */
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

const pending = new Map();
let sequence = 0;
let notices = 0;
const send = (message) => parentPort.postMessage(message);
// Shared with the host (vm-runtime.ts): [0] output tokens spent, [1] heartbeat.
const shared = new BigInt64Array(workerData.shared);
const SLOT_SPENT = 0;
const SLOT_HEARTBEAT = 1;

/*
 * The script must never hold an object of this thread's realm. From one, its
 * `.constructor.constructor` is this realm's `Function`, which compiles code
 * outside the context (`agent.constructor('return process')()`), and
 * `process` reaches the shell. A workflow launches without a permission
 * check because a script can touch nothing itself, so that has to hold.
 *
 * Two layers. First, everything the script sees is built inside the context
 * by BOOTSTRAP: its globals, its promises, its errors, and every value that
 * crosses (as JSON text, parsed in the context). The three bridge functions
 * below stay in BOOTSTRAP's closure; they take and return primitives and the
 * context's own callbacks, and never throw. The context's global has no
 * object of this realm behind it either. Second, should an object of this
 * realm still reach the script (Node rejects a dynamic `import()` with one),
 * this realm's code-generating constructors are replaced, so the chain ends
 * in a function that throws.
 */
const text = (value) => (typeof value === "string" ? value : "");

/** Start a host call. Returns "" or why it was refused (fatal for the script). */
function callHost(method, argsJson, onOk, onErr) {
	try {
		if (pending.size >= workerData.maxPending) return `Workflow agent limit reached (${workerData.maxPending} agent()/workflow() calls in flight per run)`;
		const id = sequence++;
		pending.set(id, { onOk, onErr });
		try { send({ type: "call", id, method: text(method), args: JSON.parse(text(argsJson)) }); }
		catch (error) { pending.delete(id); return text(error?.message) || "The workflow call could not be sent"; }
		return "";
	} catch {
		return "The workflow call could not be started";
	}
}

/** Send a log or phase line. Returns "" or why the script must stop. */
function noticeHost(type, value) {
	// Bound message traffic if a script loops around synchronous log/phase.
	if (++notices > workerData.maxNotices) return `Too many workflow progress messages without yielding (${workerData.maxNotices} log()/phase() calls between two heartbeats)`;
	try { send({ type: type === "phase" ? "phase" : "log", value: text(value) }); } catch { /* a closed port ends the run elsewhere */ }
	return "";
}

const spentHost = () => Number(Atomics.load(shared, SLOT_SPENT));

parentPort.on("message", ({ id, value, error }) => {
	const request = pending.get(id);
	if (!request) return;
	pending.delete(id);
	try {
		if (error) request.onErr(text(error.message), error.fatal === true);
		else request.onOk(value === undefined ? undefined : JSON.stringify(value));
	} catch (failure) {
		try { request.onErr(text(failure?.message) || "The workflow call's result could not be read", false); } catch { /* nothing left to tell */ }
	}
});

// Runs inside the context: every function, promise and error here is the context's own.
const BOOTSTRAP = `(function (callHost, noticeHost, spentHost, config, argsJson) {
"use strict";
class WorkflowScriptError extends Error {}
const call = (method, args) => new Promise((resolve, reject) => {
	while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
	let json;
	try { json = JSON.stringify(args); }
	catch (error) { reject(new WorkflowScriptError(String(error && error.message))); return; }
	const refused = callHost(method, json,
		(result) => { try { resolve(result === undefined ? undefined : JSON.parse(result)); } catch (error) { reject(error); } },
		(message, fatal) => reject(fatal ? new WorkflowScriptError(message) : new Error(message)));
	if (refused) reject(new WorkflowScriptError(refused));
});

// Callback combinators stay in the script thread: functions cannot cross the
// boundary. Fatal admission errors keep their identity across it.
async function parallel(thunks) {
	if (!Array.isArray(thunks)) throw new WorkflowScriptError("parallel() takes an array of functions");
	if (thunks.length > config.maxItems) throw new WorkflowScriptError("parallel() accepts at most " + config.maxItems + " items (got " + thunks.length + ")");
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
	if (items.length > config.maxItems) throw new WorkflowScriptError("pipeline() accepts at most " + config.maxItems + " items (got " + items.length + ")");
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
	const refused = noticeHost(type, String(value));
	if (refused) throw new WorkflowScriptError(refused);
}
const log = (value) => notice("log", value);
const budget = Object.freeze({
	total: config.total,
	spent: () => spentHost(),
	remaining: () => config.total === null ? Infinity : Math.max(0, config.total - spentHost()),
});
globalThis.__workflow__ = {
	agent: (prompt, opts) => call("agent", [prompt, opts]),
	workflow: (ref, args) => call("workflow", [ref, args]),
	parallel, pipeline,
	phase: (title) => notice("phase", title),
	log,
	console: { log, info: log, warn: (value) => log("[warn] " + String(value)), error: (value) => log("[error] " + String(value)) },
	args: argsJson === undefined ? undefined : JSON.parse(argsJson),
	budget,
};
})`;

/** The second layer: code generation in this realm ends in a function that throws. */
function blockRealmCodeGeneration() {
	const blocked = () => { throw new Error("Code generation is not available in a workflow script"); };
	for (const sample of [function () {}, async function () {}, function* () {}, async function* () {}]) {
		Object.defineProperty(Object.getPrototypeOf(sample), "constructor", { value: blocked, writable: false, configurable: false });
	}
	for (const name of ["getBuiltinModule", "binding", "dlopen", "_linkedBinding"]) {
		try { Object.defineProperty(process, name, { value: blocked, writable: false, configurable: false }); } catch { /* not present on this Node */ }
	}
}

// A busy loop or microtask spin starves this timer, so the counter stops.
const heartbeat = setInterval(() => { notices = 0; Atomics.add(shared, SLOT_HEARTBEAT, 1n); }, 25);
// First beat before the script runs: from here on the host applies the script
// timeout, not the startup grace — a script that spins from its first line is
// caught just like one that spins after an await.
Atomics.add(shared, SLOT_HEARTBEAT, 1n);
try {
	// A null-prototype sandbox: `this.constructor` in the context must not be this realm's `Object`.
	const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
	const install = new vm.Script(BOOTSTRAP, { filename: "workflow-bootstrap.js" }).runInContext(context);
	const config = new vm.Script("({})").runInContext(context);
	config.total = workerData.total;
	config.maxItems = workerData.maxItems;
	install(callHost, noticeHost, spentHost, config, workerData.args === undefined ? undefined : JSON.stringify(workerData.args));
	blockRealmCodeGeneration();
	const script = new vm.Script(workerData.source, { filename: workerData.filename });
	const value = await script.runInContext(context);
	send({ type: "result", value });
} catch (error) {
	send({ type: "error", message: error?.message ?? String(error) });
} finally {
	clearInterval(heartbeat);
	parentPort.close();
}
