#!/usr/bin/env node
/**
 * Exit probe: does anything One Code starts outlive it? Runs pi offline (the
 * golden replay's scripted model, exit-probe-fixture.ts) once per ending in
 * exit-probe-policy.mjs ENDINGS. Each run starts every long-lived kind of
 * process One Code runs, deliberately stubborn (a language server and a stdio
 * MCP server behind launchers that do not exec them and that ignore `exit`,
 * a closed stdin, SIGINT and SIGHUP; a hook's worker; a background shell's
 * leftover worker and a running one; a monitor; a subagent's leftover worker),
 * ends the run, and looks for survivors.
 *
 *   node test/e2e/exit-probe.mjs                 every ending this platform supports
 *   node test/e2e/exit-probe.mjs --only rpc-stdin,new
 *   node test/e2e/exit-probe.mjs --keep          keep each run's temp root
 *
 * Detection does not trust our bookkeeping: pi runs with a unique tag in its
 * environment (EXIT_PROBE_TAG), inherited by every descendant, and every
 * fixture also carries `<tag>:<role>` on its command line. After the ending
 * and a grace period the probe scans the process table: macOS `ps -E` (which
 * hides a platform binary's environment, hence the command-line tag), Linux
 * /proc/<pid>/environ and cmdline, Windows Win32_Process command lines. A
 * process with the tag but no role is reported as "unknown" and fails, since
 * nothing but One Code could have started it. For the `new` and `resume`
 * endings pi is still running: the processes alive before the switch that are
 * still alive after it are the survivors, and the run then ends with stdin
 * closed and is checked again as `rpc-stdin`.
 *
 * A run also fails when pi does not exit within EXIT_DEADLINE_MS of its
 * ending (a handle keeping it alive), or when a fixture never started (the
 * cell would pass untested). Every survivor is killed after it is reported.
 * Exit code 1 on any failure; the summary table lists every cell.
 *
 * Each run gets a fresh HOME, as golden-requests.mjs does. From a sandboxed
 * assistant shell, run it inside tmux (findings §10).
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { withCompactionKeepBackfilled } from "../../extensions/lib/app/compaction-keep.mjs";
import { withReplacedBuiltinsOff } from "../../extensions/lib/app/replaced-builtins.mjs";
import { cellOutcome, ENDINGS, expectation, keptOutcome, parsePs, SPAWNERS, spawnerOf } from "./exit-probe-policy.mjs";

const { values: opts } = parseArgs({
	options: {
		only: { type: "string" },
		keep: { type: "boolean", default: false },
	},
});

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const fixture = join(repo, "test/e2e/exit-probe-fixture.ts");
const procScript = join(repo, "test/e2e/exit-probe-proc.mjs");
const isWin = process.platform === "win32";
const MODEL = "anthropic/claude-opus-5-5";

/** The fixtures must all be up within this long of the prompt. */
const START_DEADLINE_MS = 60_000;
/** pi must exit within this long of its ending. */
const EXIT_DEADLINE_MS = 30_000;
/** After pi exits: time for a TERM sent at exit to land. */
const EXIT_GRACE_MS = 3_000;
/** After a session switch: an MCP close waits 2 s for the server, signals it, then waits 2 s more. */
const SWITCH_GRACE_MS = 8_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ---------------------------------------------------------------------------
// The process table

/** Every live process carrying `tag` (in its environment or command line): `{ pid, ppid, command }`. */
function scan(tag) {
	if (process.platform === "darwin") {
		const ps = (...flags) => execFileSync("ps", [...flags, "-ww", "-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		const found = parsePs(ps("-E"), tag).filter((p) => p.pid !== process.pid);
		if (found.length === 0) return found;
		// The same table without environments, for clean command lines to report.
		const commands = new Map(parsePs(ps(), "").map((p) => [p.pid, p.command]));
		return found.map((p) => ({ ...p, command: commands.get(p.pid) ?? p.command }));
	}
	if (process.platform === "linux") {
		const found = [];
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
			try {
				const command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim();
				let environ = "";
				try {
					environ = readFileSync(`/proc/${name}/environ`, "utf8");
				} catch {
					// Not ours to read: the command line still counts.
				}
				if (!command.includes(tag) && !environ.includes(`EXIT_PROBE_TAG=${tag}`)) continue;
				const ppid = Number(/^\d+ \(.*\) \S+ (\d+)/.exec(readFileSync(`/proc/${name}/stat`, "utf8"))?.[1] ?? 0);
				found.push({ pid: Number(name), ppid, command });
			} catch {
				// Gone while reading.
			}
		}
		return found;
	}
	// Windows: no readable environments; every fixture carries the tag on its command line.
	const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${tag}*' } | ForEach-Object { "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.CommandLine)" }`;
	const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
	return out
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const [pid, ppid, ...rest] = line.split("\t");
			return { pid: Number(pid), ppid: Number(ppid), command: rest.join("\t") };
		})
		.filter((p) => p.pid !== process.pid);
}

function killHard(pid) {
	try {
		if (isWin) execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
		else process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

// ---------------------------------------------------------------------------
// One run's world

function cleanEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(PI_|CC_|ONECODE_|ONE_CODE_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENROUTER_|OPEN_ROUTER_|BRAVE_|TAVILY_|EXA_|EXIT_PROBE_|GOLDEN_)/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

const q = (path) => `"${path}"`;
/** A path for a bash command line (Git Bash on Windows reads forward slashes). */
const bashPath = (path) => q(path.replace(/\\/g, "/"));

/**
 * A launcher in front of a stub server that runs it as a child (no exec) and
 * waits, as a JVM server's start script does. The trailing exit keeps a shell
 * from turning the last command into an exec.
 */
function writeLauncher(path, server, label) {
	if (isWin) {
		writeFileSync(`${path}.cmd`, `@echo off\r\nset EXIT_PROBE_STUBBORN=1\r\n"${process.execPath}" "${server}" ${label} %*\r\nexit /b %ERRORLEVEL%\r\n`);
		return `${path}.cmd`;
	}
	writeFileSync(path, `#!/bin/sh\nEXIT_PROBE_STUBBORN=1 "${process.execPath}" "${server}" ${label} "$@"\nstatus=$?\nexit $status\n`, { mode: 0o755 });
	return path;
}

function makeWorld(tag) {
	const root = join(realpathSync(os.tmpdir()), `exit-probe-${tag}`);
	const home = join(root, "home");
	const bin = join(root, "bin");
	const project = join(root, "project");
	const agentDir = join(home, ".pi", "agent");
	for (const dir of [agentDir, join(home, ".onecode"), join(home, ".claude"), bin, project]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(project, "README.md"), "# Exit probe project\n");

	writeLauncher(join(bin, "gopls"), join(repo, "test/e2e/golden-lsp-server.mjs"), `${tag}:lsp`);
	const mcp = writeLauncher(join(bin, "probe-mcp"), join(repo, "test/e2e/golden-mcp-server.mjs"), `${tag}:mcp`);
	writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ mcpServers: { probe: { command: mcp, args: [] } } }, null, 2)}\n`);
	const hook = `${bashPath(process.execPath)} ${bashPath(procScript)} fork ${tag}:hook`;
	writeFileSync(join(home, ".claude", "settings.json"), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook }] }] } }, null, 2)}\n`);

	const settings = withCompactionKeepBackfilled({ quietStartup: true, packages: [repo], extensions: withReplacedBuiltinsOff(undefined).extensions }).settings;
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	writeFileSync(join(home, ".onecode", "settings.json"), `${JSON.stringify({ modelTiers: { [MODEL]: "frontier" } }, null, 2)}\n`);

	const env = {
		...cleanEnv(),
		HOME: home,
		...(isWin ? { USERPROFILE: home } : {}),
		GOLDEN_DUMP: join(root, "requests.jsonl"),
		ANTHROPIC_API_KEY: "sk-ant-exit-probe",
		ONECODE_NO_UPDATE_CHECK: "1",
		TZ: "UTC",
		TERM: "xterm-256color",
		PATH: `${bin}${isWin ? ";" : ":"}${process.env.PATH ?? process.env.Path ?? ""}`,
		EXIT_PROBE_TAG: tag,
		EXIT_PROBE_PROC: procScript,
	};
	if (isWin) delete env.Path;
	return { root, project, env };
}

// ---------------------------------------------------------------------------
// Driving pi

/**
 * Start pi; `tui` runs it on a pty through `script`. Returns the child (the
 * launcher, for `tui`), pi's pid, an exit promise, `write(keys)` for its
 * input, `kill()` and its output so far.
 */
function startPi(world, args, { tui = false } = {}) {
	const piArgs = [piCli, "--model", MODEL, "-e", fixture, ...args];
	if (!tui) {
		const child = spawn(process.execPath, piArgs, { cwd: world.project, env: world.env, stdio: ["pipe", "pipe", "pipe"], detached: !isWin });
		child.stdin.on("error", () => {});
		const exited = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));
		const kill = () => {
			try {
				if (isWin) killHard(child.pid);
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				// Gone.
			}
		};
		return withOutput(child, { child, pid: child.pid, exited, kill, write: (keys) => child.stdin.write(keys), running: () => child.exitCode === null && child.signalCode === null });
	}
	// script(1) refuses a socket for stdin (Node's "pipe"), so `cat` feeds it
	// through a real pipe. pi runs in script's own session: the inner shell
	// writes its pid (pi's, after exec) to a file, and its exit is polled.
	const pidFile = join(world.root, "pi.pid");
	const inner = ["stty cols 120 rows 40;", `echo $$ > ${q(pidFile)};`, "exec", q(process.execPath), ...piArgs.map(q)].join(" ");
	const scriptLine = process.platform === "darwin" ? `script -q /dev/null /bin/sh -c '${inner}'` : `script -qfec '${inner}' /dev/null`;
	const child = spawn("/bin/sh", ["-c", `cat | ${scriptLine}`], { cwd: world.project, env: world.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
	child.stdin.on("error", () => {});
	let pid;
	const isAlive = (target) => {
		try {
			process.kill(target, 0);
			return true;
		} catch {
			return false;
		}
	};
	const exited = (async () => {
		for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
		pid = Number(readFileSync(pidFile, "utf8"));
		while (isAlive(pid)) await sleep(200);
		child.stdin.end();
		return { code: null, signal: null };
	})();
	const kill = () => {
		for (const target of [pid, -child.pid]) {
			try {
				if (target) process.kill(target, "SIGKILL");
			} catch {
				// Gone.
			}
		}
	};
	return withOutput(child, { child, get pid() { return pid; }, exited, kill, write: (keys) => child.stdin.write(keys), running: () => pid !== undefined && isAlive(pid) });
}

/** `pi` with `output()`: what its child wrote so far, the tail kept. */
function withOutput(child, pi) {
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
		if (output.length > 400_000) output = output.slice(-200_000);
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	return Object.assign(pi, { output: () => output });
}

/** A JSONL RPC client over the child's stdio: `send(command)` resolves with its response; `waitFor(predicate)` with the first matching event. */
function rpcClient(child) {
	let buffer = "";
	let next = 0;
	const waiters = [];
	const dialogs = [];
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
			// The switch guard asks before a session switch stops running work
			// (tools/background/switch-guard.ts): the probe means to switch. Any
			// other dialog means something asked for permission: cancel it, and it
			// shows as a fixture that never started.
			if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
				const stop = event.method === "select" ? event.options?.find((option) => option === SWITCH_STOP) : undefined;
				if (!stop) dialogs.push(event.title ?? event.message ?? event.method);
				const response = stop ? { value: stop } : { cancelled: true };
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, ...response })}\n`);
			}
			for (const waiter of [...waiters]) {
				if (waiter.match(event)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(event);
				}
			}
		}
	});
	const waitFor = (match, ms = START_DEADLINE_MS) =>
		new Promise((resolveWait, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for an RPC event`)), ms);
			waiters.push({ match, resolve: (event) => (clearTimeout(timer), resolveWait(event)) });
		});
	const send = (command) => {
		const id = `probe-${next++}`;
		const response = waitFor((event) => event.type === "response" && event.id === id);
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return response;
	};
	return { send, waitFor, dialogs };
}

const PROMPT = "PROBE_TOOLS: make the scripted calls.";
/** The switch guard's go-ahead (tools/background/switch-guard.ts SWITCH_STOP). */
const SWITCH_STOP = "Stop them and continue";

/** Poll the table until every spawner in `want` has a live process; resolves with the roles seen. */
async function waitForSpawners(tag, want, piPid, ms = START_DEADLINE_MS) {
	const seen = new Set();
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		for (const p of scan(tag)) if (p.pid !== piPid) seen.add(spawnerOf(p.command, tag));
		if (want.every((id) => seen.has(id))) return seen;
		await sleep(isWin ? 1_500 : 500);
	}
	return seen;
}

/** Wait for pi to exit within the deadline; on a hang, kill its group and say so. */
async function awaitExit(pi, label) {
	const started = Date.now();
	const outcome = await Promise.race([pi.exited, sleep(EXIT_DEADLINE_MS).then(() => undefined)]);
	if (outcome) return { hang: false, ms: Date.now() - started, ...outcome };
	pi.kill();
	return { hang: true, ms: Date.now() - started, problem: `${label}: pi did not exit within ${EXIT_DEADLINE_MS / 1000} s` };
}

/**
 * Judge the processes alive now against `ending`'s column: `only` limits the
 * judgement to those pids (the old session's, for a switch). Kills every
 * survivor it reports unless `keepAlive` (pi still running: the new session's
 * processes are not survivors, and a later check covers them).
 */
function judge({ tag, ending, starts, seen, piPid, only }) {
	const alive = scan(tag).filter((p) => p.pid !== piPid && (!only || only.has(p.pid)));
	const cells = [];
	const ids = new Set([...starts, ...alive.map((p) => spawnerOf(p.command, tag))]);
	for (const spawner of [...SPAWNERS.map((s) => s.id), "unknown"]) {
		if (!ids.has(spawner)) continue;
		const survivors = alive.filter((p) => spawnerOf(p.command, tag) === spawner);
		const expected = expectation(spawner, ending);
		const outcome = cellOutcome(expected, { seen: spawner === "unknown" || seen.has(spawner), survivors });
		cells.push({ spawner, ending, expected, survivors, ...outcome });
	}
	return { cells, alive };
}

// ---------------------------------------------------------------------------
// Endings

async function runEnding(ending) {
	const tag = `xp${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	const world = makeWorld(tag);
	const result = { ending: ending.id, cells: [], problems: [], survivorsKilled: 0 };
	let pi;
	try {
		if (ending.id.startsWith("print-")) {
			const block = ending.id === "print-sigterm" ? " PROBE_BLOCK" : "";
			pi = startPi(world, ["--mode", "json", "-p", `PROBE_TOOLS PROBE_PRINT${block}: make the scripted calls.`]);
			// A one-shot run reads piped stdin as more input: give it none.
			pi.child.stdin.end();
			let seen;
			if (ending.id === "print-sigterm") {
				seen = await waitForSpawners(tag, ending.starts, pi.child.pid);
				process.kill(pi.child.pid, "SIGTERM");
			} else {
				// Watch the run as it goes: every fixture must show up before it ends.
				seen = new Set();
				let done = false;
				pi.exited.then(() => (done = true));
				const deadline = Date.now() + START_DEADLINE_MS + EXIT_DEADLINE_MS;
				while (!done && Date.now() < deadline) {
					for (const p of scan(tag)) if (p.pid !== pi.child.pid) seen.add(spawnerOf(p.command, tag));
					await sleep(300);
				}
				// The run's own end is its ending: a run still going here hangs.
				if (!done) result.problems.push(`print-done: the one-shot run did not finish within ${(START_DEADLINE_MS + EXIT_DEADLINE_MS) / 1000} s of its start`);
			}
			await finish(result, pi, ending, tag, seen);
		} else if (ending.tui) {
			pi = startPi(world, [], { tui: true });
			await sleep(6_000);
			pi.write(`${PROMPT}\r`);
			const seen = await waitForSpawners(tag, ending.starts, pi.pid);
			if (ending.id === "tui-crash") {
				// Let the turn settle first, so the command runs as a command, not a steer.
				await sleep(3_000);
				pi.write("/probe-crash");
				await sleep(500);
				pi.write("\r");
			} else {
				pi.write("\x03");
				await sleep(200);
				pi.write("\x03");
			}
			await finish(result, pi, ending, tag, seen);
		} else {
			if (ending.id === "rpc-sigint-held") world.env.EXIT_PROBE_HOLD_SIGINT = "1";
			pi = startPi(world, ["--mode", "rpc"]);
			const rpc = rpcClient(pi.child);
			let resumeTo;
			if (ending.id === "resume") {
				// A first session to come back to, then a fresh one for the fixtures.
				const first = rpc.waitFor((event) => event.type === "agent_end");
				await rpc.send({ type: "prompt", message: "Reply with OK." });
				await first;
				resumeTo = (await rpc.send({ type: "get_state" })).data?.sessionFile;
				await rpc.send({ type: "new_session" });
			}
			const settled = rpc.waitFor((event) => event.type === "agent_end");
			await rpc.send({ type: "prompt", message: PROMPT });
			await settled;
			const seen = await waitForSpawners(tag, ending.starts, pi.child.pid);
			if (rpc.dialogs.length > 0) result.problems.push(`dialogs cancelled: ${rpc.dialogs.join("; ")}`);
			if (ending.keeps) {
				// pi survives this signal: whatever it ended, it ended while still running.
				const before = scan(tag).filter((p) => p.pid !== pi.child.pid);
				process.kill(pi.child.pid, "SIGINT");
				await sleep(SWITCH_GRACE_MS);
				if (!pi.running()) result.problems.push(`${ending.id}: pi exited on a SIGINT another listener held`);
				const after = scan(tag);
				for (const spawner of ending.starts) {
					const mine = (list) => list.filter((p) => spawnerOf(p.command, tag) === spawner);
					const outcome = keptOutcome({ seen: seen.has(spawner), before: mine(before), after: mine(after) });
					result.cells.push({ spawner, ending: ending.id, expected: { verdict: "kept", reason: "pi keeps running" }, survivors: [], ...outcome });
				}
				pi.child.stdin.end();
				await finish(result, pi, { ...ending, id: "rpc-stdin", via: `${ending.id}, then stdin closed` }, tag, seen);
			} else if (ending.alive) {
				const before = new Set(scan(tag).filter((p) => p.pid !== pi.child.pid).map((p) => p.pid));
				const switched = ending.id === "new" ? await rpc.send({ type: "new_session" }) : await rpc.send({ type: "switch_session", sessionPath: resumeTo });
				if (!switched.success || switched.data?.cancelled) result.problems.push(`${ending.id}: the switch did not happen (${JSON.stringify(switched)})`);
				await sleep(SWITCH_GRACE_MS);
				const { cells } = judge({ tag, ending: ending.id, starts: ending.starts, seen, piPid: pi.child.pid, only: before });
				result.cells.push(...cells);
				pi.child.stdin.end();
				await finish(result, pi, { ...ending, id: "rpc-stdin", via: `${ending.id}, then stdin closed` }, tag, seen);
			} else {
				if (ending.id === "rpc-stdin") pi.child.stdin.end();
				else if (ending.id === "rpc-sigterm") process.kill(pi.child.pid, "SIGTERM");
				else if (ending.id === "rpc-sighup") process.kill(pi.child.pid, "SIGHUP");
				else if (ending.id === "rpc-sigint") {
					process.kill(-pi.child.pid, "SIGINT");
					await sleep(300);
					try {
						process.kill(-pi.child.pid, "SIGINT");
					} catch {
						// The first one ended it.
					}
				} else if (ending.id === "rpc-crash") {
					// No response comes back: the process is gone before it could answer.
					rpc.send({ type: "prompt", message: "/probe-crash" }).catch(() => {});
				}
				await finish(result, pi, ending, tag, seen);
			}
		}
	} catch (error) {
		result.problems.push(`${ending.id}: ${error.message ?? error}`);
		if (pi) result.tail = pi.output().slice(-3000);
	} finally {
		if (pi?.running()) pi.kill();
		pi?.child.stdin.end();
		// Whatever is still tagged now is reported already or a leftover of a failed run: end it.
		for (const p of scan(tag)) {
			killHard(p.pid);
			result.survivorsKilled += 1;
		}
		if (!opts.keep) rmSync(world.root, { recursive: true, force: true });
		else result.root = world.root;
	}
	return result;
}

/** Wait for pi's exit, give the exit-time TERMs their grace, and judge the column. */
async function finish(result, pi, ending, tag, seen) {
	const exit = await awaitExit(pi, ending.via ?? ending.id);
	result.exit = exit;
	if (exit.hang) {
		result.problems.push(exit.problem);
		result.tail = pi.output().slice(-3000);
	}
	// A crash ending must have crashed, not quit some other way.
	if (ending.id.endsWith("-crash") && !pi.output().includes("exit-probe: deliberate crash")) result.problems.push(`${ending.id}: pi exited without the deliberate crash`);
	await sleep(EXIT_GRACE_MS);
	const { cells } = judge({ tag, ending: ending.id, starts: ending.starts, seen, piPid: undefined });
	for (const cell of cells) cell.via = ending.via;
	result.cells.push(...cells);
}

// ---------------------------------------------------------------------------
// Main

function supported(ending) {
	if (ending.posix && isWin) return "needs POSIX signals or a pty";
	if (ending.tui && !existsSync("/usr/bin/script")) return "no script(1) for a pty";
	return undefined;
}

const selected = ENDINGS.filter((e) => !opts.only || opts.only.split(",").includes(e.id));
const results = [];
for (const ending of selected) {
	const why = supported(ending);
	if (why) {
		results.push({ ending: ending.id, skipped: why, cells: [], problems: [] });
		console.log(`skip  ${ending.id}: ${why}`);
		continue;
	}
	const started = Date.now();
	const result = await runEnding(ending);
	results.push(result);
	const bad = result.cells.filter((c) => c.fails).length + result.problems.length;
	console.log(`${bad ? "FAIL" : "ok  "}  ${ending.id} (${Math.round((Date.now() - started) / 1000)} s${result.exit ? `, pi exited in ${(result.exit.ms / 1000).toFixed(1)} s` : ""})`);
	for (const cell of result.cells.filter((c) => c.survivors.length > 0 || c.ended)) {
		for (const p of [...cell.survivors, ...(cell.ended ?? [])]) console.log(`      ${cell.status.padEnd(15)} ${cell.via ?? cell.ending} / ${cell.spawner}: pid ${p.pid} ${p.command.slice(0, 220)}`);
	}
	for (const problem of result.problems) console.log(`      problem: ${problem}`);
	if (result.tail && bad) console.log(`      output tail:\n${result.tail.split("\n").slice(-25).map((l) => `        ${l}`).join("\n")}`);
	if (result.root) console.log(`      kept ${result.root}`);
}

// The summary: one row per spawner, one column per ending (a switch's second check is its own column).
const columns = [];
for (const r of results) {
	if (r.skipped) {
		columns.push({ name: r.ending, cells: new Map(), skipped: true });
		continue;
	}
	const byColumn = new Map();
	for (const cell of r.cells) {
		const name = cell.via ? `${r.ending}→exit` : r.ending;
		if (!byColumn.has(name)) byColumn.set(name, new Map());
		byColumn.get(name).set(cell.spawner, cell);
	}
	for (const [name, cells] of byColumn) columns.push({ name, cells, hang: r.exit?.hang && (name === r.ending || name.endsWith("→exit")) });
}
const rows = [...SPAWNERS.map((s) => s.id), "unknown"].filter((id) => id !== "unknown" || columns.some((c) => c.cells.has("unknown")));
const width = Math.max(16, ...columns.map((c) => c.name.length + 2));
console.log(`\n${"spawner".padEnd(12)}${columns.map((c) => c.name.slice(0, width - 1).padEnd(width)).join("")}`);
for (const row of rows) {
	const line = columns.map((c) => {
		if (c.skipped) return "skipped".padEnd(width);
		const cell = c.cells.get(row);
		return (cell ? cell.status : "n/a").slice(0, width - 1).padEnd(width);
	});
	console.log(`${row.padEnd(12)}${line.join("")}`);
}
const hangs = columns.filter((c) => c.hang).map((c) => c.name);
if (hangs.length) console.log(`\nHANG: pi did not exit within ${EXIT_DEADLINE_MS / 1000} s in ${hangs.join(", ")}`);
const open = results.flatMap((r) => r.cells).filter((c) => c.expected.verdict === "open");
if (open.length) console.log(`\nOpen policy (allowed for now): ${[...new Set(open.map((c) => `${c.spawner}: ${c.expected.reason}`))].join("; ")}`);
const failed = results.some((r) => r.problems.length > 0 || r.cells.some((c) => c.fails));
console.log(`\n${failed ? "FAIL" : "ok"}: ${results.filter((r) => !r.skipped).length} run(s), ${results.filter((r) => r.skipped).length} skipped`);
process.exit(failed ? 1 : 0);
