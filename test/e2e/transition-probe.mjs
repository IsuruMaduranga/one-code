#!/usr/bin/env node
/**
 * Live transition probe: drive one One Code session through every lifecycle
 * transition over pi's RPC mode, dump every provider request, then check that
 * the array stayed append-only (transition-check.mjs). The oracle for the
 * record-once redesign (working-docs/features/lifecycle-grid-hunt/design.md
 * section 12); run it against today's code for the baseline.
 *
 *   node test/e2e/transition-probe.mjs [--model provider/id] [--hop provider/id] [--work DIR] [--keep-mcp]
 *
 * Steps, in order (each prompt is one short request):
 *   open       read a file, then answer          (epoch: the first request)
 *   second     answer
 *   late-tool  register a deferred tool mid-session, then answer
 *   compact    /compact, then answer             (epoch: a compaction)
 *   tree       /tree back to the end of late-tool, then answer
 *   reload     /reload, then answer
 *   fork       /fork before reload's prompt, then answer
 *   resume     quit, start a new process with --continue, then answer
 *   hop-out    switch to the hop model, then answer   (epoch: a model switch)
 *   hop-back   switch back, then answer               (epoch: a model switch)
 *   clear      a new session, then answer        (epoch: an empty branch)
 *
 * Each step records which dumped requests it produced, the request it must
 * extend (`base`), whether it opens an epoch, and the assistant usages and
 * errors pi reported.
 *
 * With --oracle, each step after the first is also sent once by a fresh
 * process opened on a copy of the session file as it stood before the step
 * (the request is a pure function of the branch): its first request must
 * equal the live process's, byte for byte (`oracle` in steps.json, checked by
 * transition-check.mjs). The fresh process has the late tool while the live
 * one does (PROBE_LATE_TOOL, transition-fixture.ts). It costs one more short
 * request per step.
 *
 * Output: <work>/steps.json, wire.jsonl, wire.meta.jsonl,
 * events-<n>.jsonl, stderr-<n>.log. From a sandboxed shell run it inside tmux
 * (findings §10). The user's MCP servers are kept out unless --keep-mcp
 * (CLAUDE_CONFIG_DIR points at an empty folder). Costs about a dozen short
 * requests on the main model.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI_BIN = process.env.PI_BIN ?? join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const MODEL = flag("--model", "anthropic/claude-sonnet-5-5");
const HOP = flag("--hop", "anthropic/claude-haiku-4-5");
const KEEP_MCP = args.includes("--keep-mcp");
const ORACLE = args.includes("--oracle");
const WORK = flag("--work", undefined) ?? mkdtempSync(join(tmpdir(), "transition-probe-"));
mkdirSync(WORK, { recursive: true });
const PROJECT = join(WORK, "project");
mkdirSync(PROJECT, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: PROJECT });
writeFileSync(join(PROJECT, "CLAUDE.md"), "# Probe\n\nThrowaway project for the transition probe.\n");
writeFileSync(join(PROJECT, "notes.txt"), "The probe word is kestrel.\n");
const CONFIG = join(WORK, "claude-config");
mkdirSync(CONFIG, { recursive: true });
const WIRE = join(WORK, "wire.jsonl");
const META = join(WORK, "wire.meta.jsonl");
const STEP_TIMEOUT_MS = Number(process.env.PROBE_STEP_TIMEOUT_MS ?? 180_000);

const splitModel = (spec) => {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) throw new Error(`expected provider/model-id, got "${spec}"`);
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
};
// Fail at the start, not at the hop steps.
splitModel(MODEL);
splitModel(HOP);
const wireCount = () => (existsSync(WIRE) ? readFileSync(WIRE, "utf8").split("\n").filter((l) => l.trim()).length : 0);

/** One pi process in RPC mode, with request/response matching and an event log. */
class Pi {
	constructor(index, extraArgs, envOverrides = {}, model = MODEL) {
		this.index = index;
		this.nextId = 0;
		this.waiters = new Map();
		this.listeners = new Set();
		this.events = join(WORK, `events-${index}.jsonl`);
		const env = {
			...process.env,
			WIRE_DUMP: WIRE,
			WIRE_DUMP_META: META,
			CC_RECAP: "0",
			CC_SESSION_TITLE: "0",
			...(KEEP_MCP ? {} : { CLAUDE_CONFIG_DIR: CONFIG }),
			...envOverrides,
		};
		this.child = spawn(process.execPath, [PI_BIN, "--mode", "rpc", "-e", join(REPO, "test/e2e/dump-requests.ts"),
			"-e", join(REPO, "test/e2e/transition-fixture.ts"), "--model", model, ...extraArgs], {
			cwd: PROJECT, env, stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr.on("data", (chunk) => appendFileSync(join(WORK, `stderr-${index}.log`), chunk));
		let buffer = "";
		this.child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			let at;
			while ((at = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				if (!line.trim()) continue;
				appendFileSync(this.events, `${line}\n`);
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event.type === "response" && this.waiters.has(event.id)) {
					this.waiters.get(event.id)(event);
					this.waiters.delete(event.id);
				}
				if (event.type === "extension_ui_request") this.answerUi(event);
				for (const listener of this.listeners) listener(event);
			}
		});
		// A dead pi answers nothing: fail every request waiting on it at once, and
		// let a later write to its closed stdin fail quietly instead of crashing the probe.
		this.child.stdin.on("error", () => {});
		this.exited = new Promise((done) =>
			this.child.on("exit", (code) => {
				for (const waiter of this.waiters.values()) waiter({ type: "response", success: false, error: `pi exited with code ${code}` });
				this.waiters.clear();
				done(code);
			}),
		);
	}

	/** A dialog would stall the probe: confirm and select take the first choice, input is skipped. */
	answerUi(event) {
		if (event.method === "select") this.send({ type: "extension_ui_response", id: event.id, value: event.options?.[0] });
		else if (event.method === "confirm") this.send({ type: "extension_ui_response", id: event.id, confirmed: true });
		else if (event.method === "input" || event.method === "editor") this.send({ type: "extension_ui_response", id: event.id, cancelled: true });
	}

	send(obj) {
		this.child.stdin.write(`${JSON.stringify(obj)}\n`);
	}

	request(command) {
		const id = `probe-${this.nextId++}`;
		return new Promise((resolveResponse, reject) => {
			const timer = setTimeout(() => reject(new Error(`no response to ${command.type} within ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS);
			this.waiters.set(id, (event) => {
				clearTimeout(timer);
				if (event.success === false) reject(new Error(`${command.type} failed: ${event.error}`));
				else resolveResponse(event.data);
			});
			this.send({ ...command, id });
		});
	}

	async idle() {
		const deadline = Date.now() + STEP_TIMEOUT_MS;
		for (;;) {
			const state = await this.request({ type: "get_state" });
			if (!state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0) return state;
			if (Date.now() > deadline) throw new Error("the session never went idle");
			await new Promise((r) => setTimeout(r, 400));
		}
	}

	/** Send a prompt (or a slash command) and wait until the session is idle again, collecting assistant ends. */
	async prompt(message) {
		const ends = [];
		const listener = (event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				ends.push({ usage: event.message.usage ?? null, stopReason: event.message.stopReason, errorMessage: event.message.errorMessage ?? null });
			}
		};
		this.listeners.add(listener);
		try {
			await this.request({ type: "prompt", message });
			await new Promise((r) => setTimeout(r, 300));
			await this.idle();
		} finally {
			this.listeners.delete(listener);
		}
		return ends;
	}

	async leaf() {
		const { entries, leafId } = await this.request({ type: "get_entries" });
		const byId = new Map(entries.map((e) => [e.id, e]));
		let lastUser;
		for (let id = leafId; id; id = byId.get(id)?.parentId) {
			const entry = byId.get(id);
			if (entry?.type === "message" && entry.message?.role === "user") {
				lastUser = id;
				break;
			}
		}
		return { leafId, lastUser };
	}

	async quit() {
		this.child.stdin.end();
		const timer = setTimeout(() => this.child.kill("SIGTERM"), 15_000);
		await this.exited;
		clearTimeout(timer);
	}
}

const steps = [];
let pi = new Pi(0, []);
let processes = 1;
/** Whether the live process has the late tool registered (from late-tool until a factory re-run drops it). */
let lateToolLive = false;

/**
 * The fresh-process oracle: a new process on a copy of the session file sends
 * `message`; its first request is what the live process's must equal.
 */
async function oracleRequest(label, message) {
	const { sessionFile, model, thinkingLevel } = await pi.request({ type: "get_state" });
	if (!sessionFile || !existsSync(sessionFile)) return { error: "no session file" };
	const copy = join(WORK, `oracle-${label}.session.jsonl`);
	copyFileSync(sessionFile, copy);
	const wire = join(WORK, `oracle-${label}.wire.jsonl`);
	const fresh = new Pi(
		`oracle-${label}`,
		["--session", copy, ...(thinkingLevel ? ["--thinking", thinkingLevel] : [])],
		{ WIRE_DUMP: wire, WIRE_DUMP_META: `${wire}.meta`, ...(lateToolLive ? { PROBE_LATE_TOOL: "1" } : {}) },
		model ? `${model.provider}/${model.id}` : MODEL,
	);
	try {
		await fresh.idle();
		await fresh.prompt(message);
	} finally {
		await fresh.quit();
	}
	const first = existsSync(wire) ? readFileSync(wire, "utf8").split("\n").find((line) => line.trim()) : undefined;
	return first ? { request: first } : { error: "the fresh process sent nothing" };
}

async function step(label, { base, epoch = false, before, message, oracle = ORACLE }) {
	const record = { label, base: base ?? null, epoch, pid: processes - 1, wireStart: 0, wireEnd: 0, ends: [], error: null };
	try {
		if (before) await before();
		const expected = oracle ? await oracleRequest(label, message) : undefined;
		record.wireStart = wireCount();
		record.ends = await pi.prompt(message);
		if (expected) {
			const live = readFileSync(WIRE, "utf8").split("\n").filter((line) => line.trim())[record.wireStart];
			record.oracle = expected.error ? { error: expected.error } : { equal: live === expected.request, file: `oracle-${label}.wire.jsonl` };
		}
		record.wireEnd = wireCount();
		const { leafId, lastUser } = await pi.leaf();
		record.leafId = leafId;
		record.userEntryId = lastUser;
	} catch (error) {
		record.error = String(error?.message ?? error);
		record.wireEnd = wireCount();
	}
	steps.push(record);
	writeFileSync(join(WORK, "steps.json"), `${JSON.stringify({ model: MODEL, hop: HOP, steps }, null, 1)}\n`);
	const failed = record.error ?? record.ends.find((e) => e.stopReason === "error")?.errorMessage;
	console.log(`${label.padEnd(10)} requests ${record.wireEnd - record.wireStart}${failed ? `  ERROR ${String(failed).slice(0, 160)}` : ""}`);
	return record;
}

const answer = (word) => `Reply with exactly the word: ${word}`;
const byLabel = (label) => steps.find((s) => s.label === label);

console.log(`model:   ${MODEL} (hop ${HOP})`);
console.log(`workdir: ${WORK}`);
try {
	await pi.idle();
	await step("open", { epoch: true, oracle: false, message: `Use the read tool to read notes.txt. Then ${answer("one").toLowerCase()}` });
	await step("second", { base: "open", message: answer("two") });
	await step("late-tool", {
		base: "second",
		before: async () => {
			await pi.prompt("/probe-late-tool");
			lateToolLive = true;
		},
		message: answer("three"),
	});
	await step("compact", { epoch: true, before: () => pi.request({ type: "compact" }), message: answer("four") });
	await step("tree", { base: "late-tool", before: () => pi.prompt(`/probe-tree ${byLabel("late-tool").leafId}`), message: answer("five") });
	await step("reload", {
		base: "tree",
		before: async () => {
			await pi.prompt("/probe-reload");
			lateToolLive = false;
		},
		message: answer("six"),
	});
	await step("fork", { base: "tree", before: () => pi.request({ type: "fork", entryId: byLabel("reload").userEntryId }), message: answer("seven") });
	await step("resume", {
		base: "fork",
		before: async () => {
			await pi.quit();
			pi = new Pi(processes++, ["--continue"]);
			await pi.idle();
		},
		message: answer("eight"),
	});
	await step("hop-out", { epoch: true, before: () => pi.request({ type: "set_model", ...splitModel(HOP) }), message: answer("nine") });
	await step("hop-back", { epoch: true, before: () => pi.request({ type: "set_model", ...splitModel(MODEL) }), message: answer("ten") });
	await step("clear", { epoch: true, oracle: false, before: () => pi.request({ type: "new_session" }), message: answer("eleven") });
} finally {
	await pi.quit();
}

const check = spawnSync(process.execPath, [join(REPO, "test/e2e/transition-check.mjs"), WORK], { stdio: "inherit" });
process.exit(check.status ?? 1);
