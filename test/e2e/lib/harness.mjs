/**
 * What the e2e harnesses that run pi share: an environment with nothing that
 * steers pi or One Code, a fresh HOME with this repo as pi's only package, a
 * JSONL client for pi's RPC mode, and a kill that cannot be refused.
 * golden-requests.mjs and exit-probe.mjs run pi offline through all four;
 * live-smoke.mjs uses killHard.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCompactionKeepBackfilled } from "../../../extensions/lib/app/compaction-keep.mjs";
import { withReplacedBuiltinsOff } from "../../../extensions/lib/app/replaced-builtins.mjs";

/** This repository's root. */
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const STEERING_PREFIXES = ["PI_", "CC_", "ONECODE_", "ONE_CODE_", "CLAUDE_", "ANTHROPIC_", "OPENAI_", "OPENROUTER_", "OPEN_ROUTER_", "BRAVE_", "TAVILY_", "EXA_"];

/** The parent's environment without anything that steers pi or One Code, nor any variable starting with one of `extraPrefixes`. */
export function cleanEnv(extraPrefixes = []) {
	const prefixes = [...STEERING_PREFIXES, ...extraPrefixes];
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
		env[key] = value;
	}
	return env;
}

/**
 * Lay out one offline run under `root`: a HOME with pi's agent dir (this repo
 * as the only package, the app's settings: pi's replaced built-ins off and the
 * compaction keep window) and One Code's state folder forcing `model` onto
 * `tier`, and an empty project directory. Returns the paths and the run's base
 * environment (`cleanEnv(extraPrefixes)` with HOME, the request dump path the
 * golden fixture writes to, no update check and UTC); callers add their keys.
 */
export function writeFreshHome(root, { model, tier, extraPrefixes = [] }) {
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const project = join(root, "project");
	const dump = join(root, "requests.jsonl");
	for (const dir of [agentDir, join(home, ".onecode"), project]) mkdirSync(dir, { recursive: true });
	const settings = withCompactionKeepBackfilled({ quietStartup: true, packages: [repo], extensions: withReplacedBuiltinsOff(undefined).extensions }).settings;
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	writeFileSync(join(home, ".onecode", "settings.json"), `${JSON.stringify({ modelTiers: { [model]: tier } }, null, 2)}\n`);
	const env = {
		...cleanEnv(extraPrefixes),
		HOME: home,
		...(process.platform === "win32" ? { USERPROFILE: home } : {}),
		GOLDEN_DUMP: dump,
		ONECODE_NO_UPDATE_CHECK: "1",
		TZ: "UTC",
	};
	return { home, agentDir, project, dump, env };
}

const DIALOG_METHODS = ["select", "confirm", "input", "editor"];

/**
 * A JSONL client for pi's RPC mode over the child's stdio. Every dialog
 * (`extension_ui_request` select, confirm, input or editor) is answered with
 * what `onDialog(event)` returns (`{ value }`), or cancelled when it returns
 * nothing; then every event goes to the `onEvent` listeners. `send(command)`
 * resolves with its response, `waitFor(match, ms)` with the first matching
 * event, and `write(command)` sends a line with no wait.
 */
export function rpcClient(child, onDialog = () => undefined) {
	const listeners = new Set();
	let buffer = "";
	let next = 0;
	const write = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let at;
		while ((at = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type === "extension_ui_request" && DIALOG_METHODS.includes(event.method)) {
				write({ type: "extension_ui_response", id: event.id, ...(onDialog(event) ?? { cancelled: true }) });
			}
			for (const listener of [...listeners]) listener(event);
		}
	});
	const onEvent = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const waitFor = (match, ms = 60_000) =>
		new Promise((resolveWait, reject) => {
			const off = onEvent((event) => {
				if (!match(event)) return;
				off();
				clearTimeout(timer);
				resolveWait(event);
			});
			const timer = setTimeout(() => {
				off();
				reject(new Error("timed out waiting for an RPC event"));
			}, ms);
		});
	const send = (command) => {
		const id = `rpc-${next++}`;
		const response = waitFor((event) => event.type === "response" && event.id === id);
		write({ id, ...command });
		return response;
	};
	return { send, write, waitFor, onEvent };
}

/** SIGKILL `pid`; on Windows `taskkill /F /T` from System32 (the tree), then the process itself. Never throws. */
export function killHard(pid) {
	if (process.platform === "win32") {
		try {
			execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
		} catch {
			// Gone, or taskkill failed: the direct kill below still runs.
		}
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}
