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
 *   node test/e2e/exit-probe.mjs --jobs 1        one run at a time (default 3)
 *   node test/e2e/exit-probe.mjs --sandbox       every run with the command sandbox on (macOS, Linux; on Linux
 *                                                the sandbox ends a finished command's workers, so those are not expected)
 *
 * Detection does not trust our bookkeeping: pi runs with a unique tag in its
 * environment (EXIT_PROBE_TAG), inherited by every descendant, and every
 * fixture also carries `<tag>:<role>` on its command line. After the ending
 * the probe polls the command lines (`commandScan`) until every process the
 * ending's column expects gone is gone, for at most a grace period, then
 * scans the full process table: macOS `ps -E` (which hides a platform
 * binary's environment, hence the command-line tag), Linux
 * /proc/<pid>/environ and cmdline, Windows Win32_Process command lines. A
 * process with the tag but no role is reported as "unknown" and fails, since
 * nothing but One Code could have started it; a failing table is scanned
 * again once the grace is over, so nothing fails sooner than it would after
 * the full grace. For the `new` and `resume` endings pi is still running: the
 * processes alive before the switch that are still alive after it are the
 * survivors, and the run then ends with stdin closed and is checked again as
 * `rpc-stdin`. Runs that need no pty go `--jobs` at a time; the pty runs
 * (`tui-*`) go one at a time after them.
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
import { join } from "node:path";
import { parseArgs } from "node:util";
import { alive } from "../unit/helpers/process-alive.ts";
import { cellOutcome, endingsFor, expectation, keptOutcome, parsePs, SPAWNERS, spawnerOf } from "./exit-probe-policy.mjs";
import { killHard, repo, rpcClient, writeFreshHome } from "./lib/harness.mjs";

const { values: opts } = parseArgs({
	options: {
		only: { type: "string" },
		keep: { type: "boolean", default: false },
		jobs: { type: "string", default: "3" },
		sandbox: { type: "boolean", default: false },
	},
});

const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const fixture = join(repo, "test/e2e/exit-probe-fixture.ts");
const procScript = join(repo, "test/e2e/exit-probe-proc.mjs");
const isWin = process.platform === "win32";
const MODEL = "anthropic/claude-opus-5-5";

/** The fixtures must all be up within this long of the prompt. */
const START_DEADLINE_MS = 60_000;
/** pi must exit within this long of its ending. */
const EXIT_DEADLINE_MS = 30_000;
/** After pi exits: the most time a TERM sent at exit (and the watchdog's KILL after it) gets to land. */
const EXIT_GRACE_MS = 3_000;
/** After a session switch: an MCP close waits 2 s for the server, signals it, then waits 2 s more. The held SIGINT waits all of it. */
const SWITCH_GRACE_MS = 8_000;
/** The most an interactive pi gets to take the terminal and start its session before the prompt is typed. Polled, so a quick start costs nothing; running out is reported as a problem. */
const TUI_START_MS = 20_000;
/** Before a command is typed into the TUI: how long its output must stay quiet (the turn settled), and the most that wait takes. */
const TUI_QUIET_MS = 1_000;
const TUI_SETTLE_MS = 6_000;
/** A command typed into the TUI is typed again when it shows no effect within this long, at most this many times. */
const TUI_COMMAND_MS = 5_000;
const TUI_COMMAND_TRIES = 4;
/** How long ctrl+b may take to turn a foreground command into a background one. */
const DETACH_MS = 10_000;
/** Between two polls of the process table. */
const POLL_MS = isWin ? 500 : 100;

/** What the fixture's `/probe-crash` throws (exit-probe-fixture.ts). */
const CRASH_TEXT = "exit-probe: deliberate crash";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
/** `text` as a terminal sends a paste once the program turned bracketed paste on. */
const bracketedPaste = (text) => `\x1b[200~${text}\x1b[201~`;

/** Poll `condition` until it holds or `deadline` (a Date.now() value) passes. */
async function pollUntil(condition, deadline) {
	while (!condition() && Date.now() < deadline) await sleep(POLL_MS);
}

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

/**
 * The live processes with `tag` on their command line, which every fixture
 * carries: the cheap scan the polls use (one plain `ps` on macOS, no
 * environments read on Linux). Only `scan` sees a process tagged in its
 * environment alone, so only `scan` judges.
 */
function commandScan(tag) {
	if (process.platform === "darwin") {
		const out = execFileSync("ps", ["-ww", "-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		return parsePs(out, tag).filter((p) => p.pid !== process.pid);
	}
	if (process.platform === "linux") {
		const found = [];
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
			try {
				const command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim();
				if (command.includes(tag)) found.push({ pid: Number(name), ppid: 0, command });
			} catch {
				// Gone while reading.
			}
		}
		return found;
	}
	return scan(tag);
}

// ---------------------------------------------------------------------------
// One run's world

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
	const { home, project, env: baseEnv } = writeFreshHome(root, { model: MODEL, tier: "frontier", extraPrefixes: ["EXIT_PROBE_", "GOLDEN_"] });
	const bin = join(root, "bin");
	for (const dir of [join(home, ".claude"), bin]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(project, "README.md"), "# Exit probe project\n");

	writeLauncher(join(bin, "gopls"), join(repo, "test/e2e/golden-lsp-server.mjs"), `${tag}:lsp`);
	const mcp = writeLauncher(join(bin, "probe-mcp"), join(repo, "test/e2e/golden-mcp-server.mjs"), `${tag}:mcp`);
	writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ mcpServers: { probe: { command: mcp, args: [] } } }, null, 2)}\n`);
	const hook = `${bashPath(process.execPath)} ${bashPath(procScript)} fork ${tag}:hook`;
	writeFileSync(join(home, ".claude", "settings.json"), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook }] }] }, ...(opts.sandbox ? { sandbox: { enabled: true } } : {}) }, null, 2)}\n`);

	const env = {
		...baseEnv,
		ANTHROPIC_API_KEY: "sk-ant-exit-probe",
		TERM: "xterm-256color",
		PATH: `${bin}${isWin ? ";" : ":"}${process.env.PATH ?? process.env.Path ?? ""}`,
		EXIT_PROBE_TAG: tag,
		EXIT_PROBE_PROC: procScript,
		EXIT_PROBE_DETACHED: join(root, "detached"),
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
	const exited = (async () => {
		for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
		pid = Number(readFileSync(pidFile, "utf8"));
		while (alive(pid)) await sleep(POLL_MS);
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
	return withOutput(child, { child, get pid() { return pid; }, exited, kill, write: (keys) => child.stdin.write(keys), running: () => pid !== undefined && alive(pid) });
}

/** `pi` with `output()`: what its child wrote so far, the tail kept; `lastOutputAt()`: when it last wrote. */
function withOutput(child, pi) {
	let output = "";
	let lastOutputAt = Date.now();
	child.stdout.on("data", (chunk) => {
		output += chunk;
		lastOutputAt = Date.now();
		if (output.length > 400_000) output = output.slice(-200_000);
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
		lastOutputAt = Date.now();
	});
	return Object.assign(pi, { output: () => output, lastOutputAt: () => lastOutputAt });
}

/**
 * Submit `command` in the TUI until `tookEffect()` holds; resolves with the
 * number of tries, or 0 if it never did. It waits for the turn to settle (the
 * output quiet for TUI_QUIET_MS) first. The command goes in as a bracketed
 * paste: a single pasted line opens no slash-command completion, whereas typed
 * keys do, and an Enter that lands while the completion is still catching up
 * submits the stale highlighted entry instead of the command. Each try clears
 * the editor first (ctrl+u), so a try that left text behind cannot garble the
 * next one.
 */
async function submitTuiCommand(pi, command, tookEffect) {
	await pollUntil(() => Date.now() - pi.lastOutputAt() >= TUI_QUIET_MS, Date.now() + TUI_SETTLE_MS);
	for (let attempt = 1; attempt <= TUI_COMMAND_TRIES; attempt++) {
		pi.write(`\x15${bracketedPaste(command)}`);
		await sleep(200);
		pi.write("\r");
		await pollUntil(tookEffect, Date.now() + TUI_COMMAND_MS);
		if (tookEffect()) return attempt;
	}
	return 0;
}

/**
 * The RPC client (lib/harness.mjs) with the probe's dialog policy: the switch
 * guard asks before a session switch stops running work
 * (tools/background/switch-guard.ts), and the probe means to switch. Any other
 * dialog means something asked for permission: it is cancelled and listed in
 * `dialogs`, and shows as a fixture that never started.
 */
function probeRpc(child) {
	const dialogs = [];
	const rpc = rpcClient(child, (event) => {
		const stop = event.method === "select" ? event.options?.find((option) => option === SWITCH_STOP) : undefined;
		if (stop) return { value: stop };
		dialogs.push(event.title ?? event.message ?? event.method);
		return undefined;
	});
	return { ...rpc, dialogs };
}

/**
 * Send `message` as a prompt and wait for its turn to end. Both waits are
 * joined at once: one that rejects (an RPC timeout) fails the run through
 * runEnding's catch, and the other's later rejection is already handled
 * instead of ending the whole probe as an unhandled rejection.
 */
async function promptAndSettle(rpc, message) {
	await Promise.all([rpc.waitFor((event) => event.type === "agent_end"), rpc.send({ type: "prompt", message })]);
}

const PROMPT = "PROBE_TOOLS: make the scripted calls.";
/** The switch guard's go-ahead (tools/background/switch-guard.ts SWITCH_STOP). */
const SWITCH_STOP = "Stop them and continue";

/** Poll the table until every spawner in `want` has a live process; resolves with the roles seen. */
async function waitForSpawners(tag, want, piPid, ms = START_DEADLINE_MS) {
	const seen = new Set();
	const deadline = Date.now() + ms;
	await pollUntil(() => {
		for (const p of commandScan(tag)) if (p.pid !== piPid) seen.add(spawnerOf(p.command, tag));
		return want.every((id) => seen.has(id));
	}, deadline);
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

/**
 * Judge as `judge` does, once the processes `ending` expects gone are gone:
 * poll the command lines until none of them is left (and `ready()` holds), for
 * at most `capMs`, then judge on the full table. A failing judgement before
 * the cap (a process tagged only in its environment, which the poll cannot
 * see) is judged again at the cap, so nothing fails sooner than after the
 * full grace.
 */
async function settleAndJudge(args, capMs, ready = () => true) {
	const { tag, ending, piPid, only } = args;
	const deadline = Date.now() + capMs;
	const leftToGo = () => commandScan(tag).some((p) => p.pid !== piPid && (!only || only.has(p.pid)) && expectation(spawnerOf(p.command, tag), ending).verdict === "gone");
	await pollUntil(() => ready() && !leftToGo(), deadline);
	const judged = judge(args);
	if (!judged.cells.some((cell) => cell.fails) || Date.now() >= deadline) return judged;
	await sleep(deadline - Date.now());
	return judge(args);
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
				await pollUntil(() => {
					for (const p of commandScan(tag)) if (p.pid !== pi.child.pid) seen.add(spawnerOf(p.command, tag));
					return done;
				}, deadline);
				// The run's own end is its ending: a run still going here hangs.
				if (!done) result.problems.push(`print-done: the one-shot run did not finish within ${(START_DEADLINE_MS + EXIT_DEADLINE_MS) / 1000} s of its start`);
			}
			await finish(result, pi, ending, tag, seen);
		} else if (ending.tui) {
			pi = startPi(world, [], { tui: true });
			// Ready once the TUI has the terminal (bracketed paste on) and the session has started (its SessionStart hook ran).
			const ready = () => pi.output().includes("\x1b[?2004h") && commandScan(tag).some((p) => spawnerOf(p.command, tag) === "hook");
			await pollUntil(ready, Date.now() + TUI_START_MS);
			// The prompt is typed either way, so a slow start still gets its chance; a run that passes only because of that is still reported.
			if (!ready()) result.problems.push(`${ending.id}: the TUI was not ready within ${TUI_START_MS / 1000} s (bracketed paste on and the SessionStart hook run); the prompt was typed anyway`);
			pi.write(`${PROMPT.replace("PROBE_TOOLS", "PROBE_TOOLS PROBE_FG")}\r`);
			const seen = await waitForSpawners(tag, ending.starts, pi.pid);
			// The foreground command holds the turn: ctrl+b sends it to the background, and the fixture marks the result.
			pi.write("\x02");
			await pollUntil(() => existsSync(world.env.EXIT_PROBE_DETACHED), Date.now() + DETACH_MS);
			if (!existsSync(world.env.EXIT_PROBE_DETACHED)) result.problems.push(`${ending.id}: ctrl+b did not send the foreground command to the background within ${DETACH_MS / 1000} s`);
			if (ending.id === "tui-crash") {
				// The command took effect once pi crashed or exited; finish judges which.
				const tries = await submitTuiCommand(pi, "/probe-crash", () => !pi.running() || pi.output().includes(CRASH_TEXT));
				if (tries === 0) result.problems.push(`tui-crash: /probe-crash showed no effect after ${TUI_COMMAND_TRIES} tries`);
			} else {
				pi.write("\x03");
				await sleep(200);
				pi.write("\x03");
			}
			await finish(result, pi, ending, tag, seen);
		} else {
			if (ending.id === "rpc-sigint-held") world.env.EXIT_PROBE_HOLD_SIGINT = "1";
			pi = startPi(world, ["--mode", "rpc"]);
			const rpc = probeRpc(pi.child);
			let resumeTo;
			if (ending.id === "resume") {
				// A first session to come back to, then a fresh one for the fixtures.
				await promptAndSettle(rpc, "Reply with OK.");
				resumeTo = (await rpc.send({ type: "get_state" })).data?.sessionFile;
				await rpc.send({ type: "new_session" });
			}
			await promptAndSettle(rpc, PROMPT);
			const seen = await waitForSpawners(tag, ending.starts, pi.child.pid);
			if (rpc.dialogs.length > 0) result.problems.push(`dialogs cancelled: ${rpc.dialogs.join("; ")}`);
			if (ending.keeps) {
				// pi survives this signal: whatever it ended, it ended while still running.
				// The full wait proves survival, so it is not cut short.
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
				const old = scan(tag).filter((p) => p.pid !== pi.child.pid);
				const before = new Set(old.map((p) => p.pid));
				// Only a spawner the old session still had running is exercised by the switch: one already
				// gone before it would pass as "gone" untested, so it counts as not started.
				const running = new Set(old.map((p) => spawnerOf(p.command, tag)));
				const switched = ending.id === "new" ? await rpc.send({ type: "new_session" }) : await rpc.send({ type: "switch_session", sessionPath: resumeTo });
				if (!switched.success || switched.data?.cancelled) result.problems.push(`${ending.id}: the switch did not happen (${JSON.stringify(switched)})`);
				const { cells } = await settleAndJudge({ tag, ending: ending.id, starts: ending.starts, seen: running, piPid: pi.child.pid, only: before }, SWITCH_GRACE_MS);
				// An exit would end the old session's processes too: they are judged gone only if pi lives.
				if (!pi.running()) result.problems.push(`${ending.id}: pi exited during the session switch`);
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

/** Wait for pi's exit, give the exit-time TERMs up to their grace, and judge the column. */
async function finish(result, pi, ending, tag, seen) {
	const exit = await awaitExit(pi, ending.via ?? ending.id);
	result.exit = exit;
	if (exit.hang) {
		result.problems.push(exit.problem);
		result.tail = pi.output().slice(-3000);
	}
	// A crash ending must have crashed, not quit some other way.
	if (ending.id.endsWith("-crash") && !pi.output().includes(CRASH_TEXT)) result.problems.push(`${ending.id}: pi exited without the deliberate crash`);
	const { cells } = await settleAndJudge({ tag, ending: ending.id, starts: ending.starts, seen, piPid: undefined }, EXIT_GRACE_MS);
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

/** Print one run's line, its survivors and its problems. */
function report(ending, result) {
	if (result.skipped) {
		console.log(`skip  ${ending.id}: ${result.skipped}`);
		return;
	}
	const bad = result.cells.filter((c) => c.fails).length + result.problems.length;
	console.log(`${bad ? "FAIL" : "ok  "}  ${ending.id} (${Math.round(result.ms / 1000)} s${result.exit ? `, pi exited in ${(result.exit.ms / 1000).toFixed(1)} s` : ""})`);
	for (const cell of result.cells.filter((c) => c.survivors.length > 0 || c.ended)) {
		for (const p of [...cell.survivors, ...(cell.ended ?? [])]) console.log(`      ${cell.status.padEnd(15)} ${cell.via ?? cell.ending} / ${cell.spawner}: pid ${p.pid} ${p.command.slice(0, 220)}`);
	}
	for (const problem of result.problems) console.log(`      problem: ${problem}`);
	if (result.tail && bad) console.log(`      output tail:\n${result.tail.split("\n").slice(-25).map((l) => `        ${l}`).join("\n")}`);
	if (result.root) console.log(`      kept ${result.root}`);
}

const selected = endingsFor({ sandbox: opts.sandbox, platform: process.platform }).filter((e) => !opts.only || opts.only.split(",").includes(e.id));
const results = new Array(selected.length);
let printed = 0;
/** Record run `index` and print every finished run up to the first one still going, in table order. */
const finished = (index, result) => {
	results[index] = result;
	while (printed < selected.length && results[printed]) report(selected[printed], results[printed++]);
};
const timed = async (ending) => {
	const started = Date.now();
	const result = await runEnding(ending);
	return { ...result, ms: Date.now() - started };
};

// The runs with no pty, `--jobs` at a time; then the pty runs, one at a time.
const queue = [];
selected.forEach((ending, index) => {
	const why = supported(ending);
	if (why) finished(index, { ending: ending.id, skipped: why, cells: [], problems: [] });
	else queue.push({ ending, index });
});
const pooled = queue.filter(({ ending }) => !ending.tui);
const lanes = Array.from({ length: Math.max(1, Number(opts.jobs) || 1) }, async () => {
	for (let job = pooled.shift(); job; job = pooled.shift()) finished(job.index, await timed(job.ending));
});
await Promise.all(lanes);
for (const { ending, index } of queue.filter(({ ending }) => ending.tui)) finished(index, await timed(ending));

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
