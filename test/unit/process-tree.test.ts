/**
 * lib/shell-run/process-tree.ts against real shells (the repo never mocks child_process).
 * With zsh as $SHELL, `cmd; echo` and pipelines run the command outside the
 * `$SHELL -c` leader; signalling the leader alone left them as orphans holding
 * the stdout pipe (LIFECYCLE-REVIEW-2026-09-06 M2). Detached spawn + group kill
 * ends the whole tree, so `close` fires promptly.
 *
 * On Windows `close` is not the contract: the first CI run showed every
 * process of a killed Git Bash tree gone (tasklist empty) with the inherited
 * pipe still open — a handle leaked into an unrelated concurrent child of the
 * same test process — so there the assertions time `waitForChildExit`, which
 * is what every task and hook waits on (findings §22, 2026-09-19 addendum).
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detachedSpawnOptions, EXIT_STDIO_MAX_MS, KILL_GRACE_MS, killProcessTree, rememberedGroupAlive, spawnOwnedTree, waitForChildExit } from "../../extensions/lib/shell-run/process-tree.ts";
import { bashSpawnOrThrow } from "../../extensions/lib/shell-run/shell-spawn.ts";
import { alive, startOwner, until } from "./helpers/process-alive.ts";

const win32 = process.platform === "win32";

// The shell One Code spawns: $SHELL here (zsh on macOS is the interesting
// case), the resolved bash — Git Bash — on Windows, where $SHELL is unset.
const bash = bashSpawnOrThrow();
const shell = win32 ? bash.shell : process.env.SHELL || bash.shell;

/** Room for a loaded machine (a full suite with the base suite beside it): these tests wait on real processes. */
const LOADED_MS = 15_000;
/** What "at once" means here: far below the 30 s that every tree's `sleep 30` would hold the pipe if the kill missed it, with room for a loaded machine. */
const AT_ONCE_MS = 10_000;

/**
 * Resolves once the group `child` leads runs every command in `names`: a
 * member still being forked when the group signal goes out is missed, and
 * holds the pipe for its 30 s. Windows has no groups (and no pgrep), so a
 * short pause stands in there.
 */
async function membersStarted(child: ReturnType<typeof spawn>, names: string[]): Promise<void> {
	if (win32) return new Promise((r) => setTimeout(r, 100));
	const running = (name: string) => {
		try {
			execFileSync("pgrep", ["-g", String(child.pid), "-x", name], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	const started = await until(() => names.every(running), 200);
	// A failed wait must not leave the group holding its pipes for 30 s.
	if (!started) killProcessTree(child, "SIGKILL");
	expect(started).toBe(true);
}

function spawnShell(command: string) {
	return spawn(shell, ["-c", command], { ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** `command` under the shell as an owned tree. */
function ownedShell(command: string, options?: Parameters<typeof spawnOwnedTree>[1]) {
	return spawnOwnedTree((detached) => spawn(shell, ["-c", command], { ...detached, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), options);
}

/** Resolves with the wall time to `close`, or rejects after `limitMs`. */
function closeWithin(child: ReturnType<typeof spawn>, limitMs: number): Promise<number> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no close within ${limitMs} ms`)), limitMs);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(Date.now() - started);
		});
	});
}

/** The wall time to `waitForChildExit` settling — the wait the tasks and hooks use. */
async function exitWithin(child: ReturnType<typeof spawn>): Promise<number> {
	const started = Date.now();
	await waitForChildExit(child);
	return Date.now() - started;
}

/** `close` on POSIX (the pipe closes with the tree); the exit-based wait on Windows. */
const settledWithin = (child: ReturnType<typeof spawn>, limitMs: number) => (win32 ? exitWithin(child) : closeWithin(child, limitMs));

describe("killProcessTree", { timeout: LOADED_MS }, () => {
	it("ends a pipeline's members, not just the shell, so the stdout pipe closes at once", async () => {
		const child = spawnShell("sleep 30 | cat");
		await membersStarted(child, ["sleep", "cat"]);
		const settled = settledWithin(child, AT_ONCE_MS);
		killProcessTree(child);
		expect(await settled).toBeLessThan(AT_ONCE_MS);
	});

	it("ends a `cmd; more` sequence the same way", async () => {
		const child = spawnShell("sleep 30; echo done");
		await membersStarted(child, ["sleep"]);
		const settled = settledWithin(child, AT_ONCE_MS);
		killProcessTree(child);
		expect(await settled).toBeLessThan(AT_ONCE_MS);
	});

	it("waitForChildExit settles on exit plus the stdio grace, so a pipe a straggler holds cannot hang the wait", async () => {
		const child = spawnShell("sleep 30 | cat");
		await new Promise((r) => setTimeout(r, 100));
		const started = Date.now();
		const exited = waitForChildExit(child);
		killProcessTree(child);
		const { code, signal } = await exited;
		expect(Date.now() - started).toBeLessThan(AT_ONCE_MS);
		expect(code === null || code !== 0 || signal !== null).toBe(true);
	});

	it("waitForChildExit settles within the post-exit cap when a straggler keeps writing to the inherited pipe", async () => {
		// The leader exits at once; the backgrounded loop it left behind writes
		// every 50 ms, re-arming the stdio grace forever without the cap. The cap
		// counts from the leader's exit, so that is where the clock starts; the
		// slack is for timers firing late on a loaded machine.
		const child = spawnShell("(while true; do echo x; sleep 0.05; done) & exit 0");
		let exitedAt = 0;
		child.once("exit", () => (exitedAt = Date.now()));
		await waitForChildExit(child);
		// The wait settled on the leader's exit, not on an error path.
		expect(exitedAt).toBeGreaterThan(0);
		expect(Date.now() - exitedAt).toBeLessThan(EXIT_STDIO_MAX_MS + 2000);
		killProcessTree(child, "SIGKILL"); // the loop is not the leader's group on Windows; best effort
	});

	it.skipIf(win32)("freezes the group before signalling it, and resumes it unless the signal was SIGKILL", async () => {
		const sent: string[] = [];
		const kill = vi.spyOn(process, "kill");
		try {
			const term = spawnShell("sleep 30");
			const killed = spawnShell("sleep 30");
			await new Promise((r) => setTimeout(r, 100));
			const settled = Promise.all([settledWithin(term, AT_ONCE_MS), settledWithin(killed, AT_ONCE_MS)]);
			killProcessTree(term);
			killProcessTree(killed, "SIGKILL");
			// Only these two groups: a re-check an earlier test's SIGKILL left pending may probe its own group meanwhile.
			for (const [pid, signal] of kill.mock.calls) if (pid === -term.pid! || pid === -killed.pid!) sent.push(`${pid === -term.pid! ? "term" : "killed"}:${signal}`);
			await settled;
		} finally {
			kill.mockRestore();
		}
		expect(sent).toEqual(["term:SIGSTOP", "term:SIGTERM", "term:SIGCONT", "killed:SIGSTOP", "killed:SIGKILL"]);
	});

	it.skipIf(win32)("resumes a group it froze when the signal itself could not be sent, SIGKILL included", async () => {
		const child = spawnShell("sleep 30");
		await new Promise((r) => setTimeout(r, 100));
		const real = process.kill.bind(process);
		const sent: string[] = [];
		const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === -child.pid!) sent.push(String(signal));
			if (pid === -child.pid! && signal === "SIGKILL") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			return real(pid, signal as NodeJS.Signals);
		});
		try {
			const settled = settledWithin(child, AT_ONCE_MS);
			killProcessTree(child, "SIGKILL");
			expect(sent).toEqual(["SIGSTOP", "SIGKILL", "SIGCONT"]);
			await settled; // the leader was still killed directly
		} finally {
			kill.mockRestore();
			killProcessTree(child, "SIGKILL");
		}
	});

	it.skipIf(win32)("a shell whose command the kill ended never runs its next command or reports the job", async () => {
		// Unfrozen, the command can die before its shell is signalled; the shell
		// then reaps it, prints the job report and runs on (see killProcessTree).
		const runs = await Promise.all(
			Array.from({ length: 24 }, async () => {
				const child = spawn(bash.shell, ["-c", "echo ready; sleep 30; echo ran-on"], { ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				let err = "";
				child.stdout?.on("data", (chunk) => (out += chunk));
				child.stderr?.on("data", (chunk) => (err += chunk));
				while (!out.includes("ready")) await new Promise((r) => setTimeout(r, 5));
				const exited = waitForChildExit(child);
				killProcessTree(child, "SIGKILL");
				await exited;
				return { out: out.trim(), err };
			}),
		);
		expect(runs).toEqual(runs.map(() => ({ out: "ready", err: "" })));
	});

	it.skipIf(win32)("a SIGKILL leaves no member behind in a group that is forking as it lands", async () => {
		// A process forking when the group signal lands can hand the group a child the
		// signal never reached (macOS: 11 of 100 such groups outlived a single SIGKILL,
		// 31 of 100 under load). The kill re-checks the group and signals it again while it
		// has members; 40 groups make a miss without that near certain (about 99%).
		const rounds = 5;
		const perRound = 8;
		const survivors: number[] = [];
		for (let round = 0; round < rounds; round++) {
			const children = Array.from({ length: perRound }, () =>
				// Forks for long enough to be mid-loop when the kill lands, and no further: a late timer on a
				// loaded machine must not let a shell fill the process table.
				spawn("/bin/sh", ["-c", "i=0; while [ $i -lt 300 ]; do sleep 5 & i=$((i+1)); done; wait"], { ...detachedSpawnOptions(), stdio: "ignore" }),
			);
			await new Promise((r) => setTimeout(r, 20)); // every shell is mid-loop
			const exited = children.map((child) => (child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve()));
			for (const child of children) killProcessTree(child, "SIGKILL");
			await Promise.all(exited);
			// Past the re-check window (and the leaders' reaping), with room for a loaded machine.
			await until(() => children.every((child) => !rememberedGroupAlive(child)), 40);
			for (const child of children) {
				if (!rememberedGroupAlive(child)) continue;
				survivors.push(child.pid!);
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {
					// Gone meanwhile.
				}
			}
		}
		expect(survivors).toEqual([]);
		// Forty forking shells take seconds on a loaded machine: the default five would fail the test for being slow.
	}, 60_000);

	it.skipIf(win32)("a frozen group still runs its TERM handler", async () => {
		// `ready` comes once the member is forked, so the kill always finds a group of two.
		const child = spawn(bash.shell, ["-c", "trap 'echo handled; exit 0' TERM; sleep 30 & echo ready; wait"], { ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout?.on("data", (chunk) => (out += chunk));
		while (!out.includes("ready")) await new Promise((r) => setTimeout(r, 5));
		const exited = waitForChildExit(child);
		killProcessTree(child);
		expect((await exited).code).toBe(0);
		expect(out).toContain("handled");
	});
});

describe("an owned tree's stop", { timeout: LOADED_MS }, () => {
	// Windows has no SIGTERM to ignore: taskkill /F is the first and only signal,
	// so the grace period does not exist there (lib/shell-run/process-tree.ts).

	/** Whether any process is left in the group `pgid`. */
	const groupAlive = (pgid: number) => {
		try {
			process.kill(-pgid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	};
	const waitUntilGone = async (pgid: number, limitMs: number) => {
		for (let waited = 0; groupAlive(pgid) && waited < limitMs; waited += 50) await new Promise((r) => setTimeout(r, 50));
		return !groupAlive(pgid);
	};
	/**
	 * A group whose leader dies on TERM while a member it forked ignores TERM (the
	 * `bash -c` wrapper around a dev server). The member prints `ready` once its trap is set.
	 */
	const leaderDiesMemberResists = `sh -c 'trap "" TERM; echo ready; while :; do sleep 0.2; done' & wait`;

	it.skipIf(win32)("schedules the SIGKILL of a new child that reuses a pending child's pid", async () => {
		// A pid no system hands out, so the group kill fails with ESRCH and falls
		// back to each fake child's own kill(): nothing real is signalled.
		const pid = 2_147_483_000;
		const fake = () => Object.assign(new EventEmitter(), { pid, kill: vi.fn(), exitCode: null as number | null, signalCode: null }) as unknown as ReturnType<typeof spawn>;
		const first = spawnOwnedTree(fake);
		const second = spawnOwnedTree(fake);
		first.stop(30);
		second.stop(30);
		await new Promise((r) => setTimeout(r, 120));
		expect(first.child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(second.child.kill).toHaveBeenCalledWith("SIGKILL");
		// Let the fakes "exit", so they are forgotten.
		for (const { child } of [first, second]) {
			(child as { exitCode: number | null }).exitCode = 0;
			child.emit("exit", 0, null);
		}
	});

	it.skipIf(win32)("leaves a tree already in its grace to that stop: a second stop sends no second SIGTERM", async () => {
		// A pid no system hands out, so the group kill fails with ESRCH and falls back
		// to the fake child's own kill(): the signals sent are the calls it records.
		const signals: string[] = [];
		let sigkilled!: () => void;
		const killed = new Promise<void>((resolve) => (sigkilled = resolve));
		const kill = vi.fn((signal: string) => {
			signals.push(signal);
			if (signal === "SIGKILL") sigkilled();
			return true;
		});
		const fake = () => Object.assign(new EventEmitter(), { pid: 2_147_482_900, kill, exitCode: null as number | null, signalCode: null }) as unknown as ReturnType<typeof spawn>;
		const tree = spawnOwnedTree(fake);
		tree.stop(30);
		tree.stop(30);
		await killed;
		// One SIGTERM, then the one SIGKILL the first stop scheduled.
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		(tree.child as { exitCode: number | null }).exitCode = 0;
		tree.child.emit("exit", 0, null);
	});

	it.skipIf(win32)("SIGKILLs the group after the grace even when the leader died on SIGTERM and a member did not (A3-M1)", async () => {
		const tree = spawnOwnedTree((detached) => spawn(bash.shell, ["-c", leaderDiesMemberResists], { ...detached, stdio: ["ignore", "pipe", "ignore"] }));
		const child = tree.child;
		const pgid = child.pid!;
		try {
			await once(child.stdout!, "data"); // the member has set its trap
			const exited = new Promise((r) => child.once("exit", r));
			tree.stop(300);
			await exited; // the leader goes at once
			expect(await waitUntilGone(pgid, 3000)).toBe(true);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});

	it.skipIf(win32)("ends a stopped tree after the exit watchdog's grace when the process exits before its grace timer could fire (A3-M1, the quit path)", async () => {
		// A throwaway node process stops its own TERM-resistant group once the member
		// has set its trap, and exits 50 ms later, as pi's quit does (dispose, then process.exit).
		const moduleUrl = new URL(`file://${resolve("extensions/lib/shell-run/process-tree.ts")}`).href;
		const script = [
			`import { spawn } from "node:child_process";`,
			`import { spawnOwnedTree } from ${JSON.stringify(moduleUrl)};`,
			`const tree = spawnOwnedTree((detached) => spawn(${JSON.stringify(bash.shell)}, ["-c", ${JSON.stringify(leaderDiesMemberResists)}], { ...detached, stdio: ["ignore", "pipe", "ignore"] }));`,
			`tree.child.unref();`,
			`process.stdout.write(String(tree.child.pid));`,
			`tree.child.stdout.once("data", () => { tree.stop(2000); setTimeout(() => process.exit(0), 50); });`,
		].join("\n");
		const stdout = await new Promise<string>((done, fail) =>
			execFile(process.execPath, ["--input-type=module", "-e", script], (error, out) => (error ? fail(error) : done(out))),
		);
		const pgid = Number(stdout.trim());
		expect(pgid).toBeGreaterThan(0);
		try {
			// The stop's timer died with the process; the exit watchdog SIGKILLs the
			// member that outlasts the grace (process-group-exit.test.ts checks the grace).
			expect(await waitUntilGone(pgid, KILL_GRACE_MS + 2000)).toBe(true);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});

	it("ends the tree at once where there is no gentler signal to grace (Windows)", async () => {
		const tree = ownedShell("sleep 30");
		await new Promise((r) => setTimeout(r, 150));
		const settled = settledWithin(tree.child, AT_ONCE_MS);
		tree.stop(300);
		expect(await settled).toBeLessThan(AT_ONCE_MS);
	});
});

describe("spawnOwnedTree", { timeout: LOADED_MS }, () => {
	/** A launcher that starts a member in its group (off the test's pipes), prints the member's pid and exits at once. */
	const launcherLeavesMember = "sleep 30 </dev/null >/dev/null 2>&1 & echo $!";

	/** Start `command` as an owned tree; resolves once the leader has printed its first line. */
	const startTree = async (command: string, options?: Parameters<typeof spawnOwnedTree>[1]) => {
		const tree = ownedShell(command, options);
		let out = "";
		tree.child.stdout?.on("data", (chunk) => (out += chunk));
		while (!out.includes("\n")) await new Promise((r) => setTimeout(r, 5));
		return { tree, firstLine: out.trim() };
	};

	it("hands the spawn call the detached options and returns its child", async () => {
		const start = vi.fn(() => spawn(shell, ["-c", "exit 0"], { stdio: "ignore", windowsHide: true }));
		const tree = spawnOwnedTree(start);
		expect(start).toHaveBeenCalledWith(detachedSpawnOptions());
		expect(tree.child).toBe(start.mock.results[0]!.value);
		await waitForChildExit(tree.child);
	});

	it.skipIf(win32)("starts the child as the leader of its own group", async () => {
		// The member is forked before the ready line: a group kill that lands while the shell is still
		// forking it can miss the new child on macOS, which then holds the group for its 30 s.
		const { tree } = await startTree("sleep 30 & echo ready; wait");
		try {
			expect(tree.alive()).toBe(true);
		} finally {
			tree.kill("SIGKILL");
		}
		expect(await until(() => !tree.alive(), 200)).toBe(true);
	});

	it.skipIf(win32)("ends the rest of the group when the launcher exits, with endGroupWithLauncher", async () => {
		const { tree, firstLine } = await startTree(launcherLeavesMember, { endGroupWithLauncher: true });
		const member = Number(firstLine);
		try {
			expect(member).toBeGreaterThan(0);
			expect(await until(() => !alive(member), 200)).toBe(true);
			expect(tree.alive()).toBe(false);
		} finally {
			tree.kill("SIGKILL");
		}
	});

	it.skipIf(win32)("leaves what a finished leader started running, without endGroupWithLauncher", async () => {
		const { tree, firstLine } = await startTree(launcherLeavesMember);
		const member = Number(firstLine);
		try {
			if (tree.child.exitCode === null) await once(tree.child, "exit");
			await new Promise((r) => setTimeout(r, 300));
			expect(alive(member)).toBe(true);
			expect(tree.alive()).toBe(true);
		} finally {
			tree.kill("SIGKILL");
		}
		expect(await until(() => !alive(member), 200)).toBe(true);
	});

	it.skipIf(win32)("stop SIGTERMs the tree and SIGKILLs it after the grace", async () => {
		const { tree } = await startTree("trap '' TERM; echo ready; sleep 30");
		const graceMs = 300;
		const closed = closeWithin(tree.child, AT_ONCE_MS);
		tree.stop(graceMs);
		// No SIGKILL before the grace (the timer never fires early; 50 ms for clock
		// rounding), and one after it, long before the TERM-ignoring sleep's 30 s.
		const elapsed = await closed;
		expect(elapsed).toBeGreaterThanOrEqual(graceMs - 50);
		expect(elapsed).toBeLessThan(AT_ONCE_MS);
	});

	it("kill ends the whole tree at once", async () => {
		const { tree } = await startTree("echo ready; sleep 30 | cat");
		await membersStarted(tree.child, ["sleep", "cat"]);
		const settled = settledWithin(tree.child, AT_ONCE_MS);
		tree.kill("SIGKILL");
		expect(await settled).toBeLessThan(AT_ONCE_MS);
	});
});

describe("rememberedGroupAlive", () => {
	const onPlatform = (platform: NodeJS.Platform, run: () => void) => {
		const original = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...original, value: platform });
		try {
			run();
		} finally {
			Object.defineProperty(process, "platform", original);
		}
	};
	// A pid that is certainly alive (this process) stands in for one Windows
	// handed to a new process after the remembered leader exited.
	const child = (exitCode: number | null, signalCode: NodeJS.Signals | null) =>
		({ pid: process.pid, exitCode, signalCode }) as unknown as ReturnType<typeof spawn>;

	it("on Windows, judges by the remembered child's own exit, not by probing a pid that may be reused", () => {
		onPlatform("win32", () => {
			expect(rememberedGroupAlive(child(0, null))).toBe(false);
			expect(rememberedGroupAlive(child(null, "SIGTERM"))).toBe(false);
			expect(rememberedGroupAlive(child(null, null))).toBe(true);
		});
	});
});

// On Windows a tree is ended by `taskkill /T` from the exit hook. Started async as the
// process left, it ended the launcher but not the server under it, on every exit and crash
// (16 of 16 runs on the Windows runner); the hook now waits for it.
describe.runIf(win32)("an owned tree on Windows when its owner leaves without stopping it", () => {
	it.each([
		["exits", "process.exit(0);"],
		["crashes", 'setTimeout(() => { throw new Error("crash"); }, 0);'],
	])("is ended when the owner %s", async (_, leave) => {
		const { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { createRequire } = await import("node:module");
		const dir = mkdtempSync(join(tmpdir(), "owned-tree-exit-"));
		const pidFile = join(dir, "server.pid");
		const jitiPath = createRequire(resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")).resolve("jiti");
		const serverFile = join(dir, "server.cjs");
		writeFileSync(serverFile, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
		// The launcher is cmd.exe waiting on a node server, the shape of a .cmd-shimmed language server.
		const line = `""${process.execPath}" "${serverFile}""`;
		const script = [
			`import { createRequire } from "node:module";`,
			`import { spawn } from "node:child_process";`,
			`const { createJiti } = createRequire(import.meta.url)(${JSON.stringify(jitiPath)});`,
			`const { spawnOwnedTree } = await createJiti(import.meta.url).import(${JSON.stringify(resolve("extensions/lib/shell-run/process-tree.ts"))});`,
			`spawnOwnedTree((d) => spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ${JSON.stringify(line)}], { ...d, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }));`,
			`setInterval(() => {}, 1000);`,
			`process.stdout.write("ready\\n");`,
			`process.stdin.once("data", () => { ${leave} });`,
		].join("\n");
		const run = await startOwner(script);
		let pid: number | undefined;
		try {
			expect(await until(() => existsSync(pidFile), 200)).toBe(true);
			pid = Number(readFileSync(pidFile, "utf8"));
			expect(alive(pid)).toBe(true);
			run.owner.stdin.write("go\n");
			await run.exited;
			expect(await until(() => !alive(pid!), 100)).toBe(true);
		} finally {
			run.kill();
			if (pid && alive(pid)) process.kill(pid);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
