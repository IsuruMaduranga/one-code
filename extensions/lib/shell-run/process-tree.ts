/**
 * Owned process trees: how every long-lived child process One Code starts
 * (background shells and monitors, language servers, stdio MCP servers) is
 * started, owned and ended, and the one way to wait for a child to finish.
 *
 * A child is only the leader of what it starts. A `$SHELL -c "cmd"` with zsh
 * (macOS default) runs a `cmd; echo` or a pipeline in further processes, and a
 * language or MCP server is often a launcher (a shell script, `npx`, a `.cmd`
 * shim) in front of the real process. `child.kill()` signals the leader alone:
 * the rest lives on as an orphan holding the inherited stdout pipe, so `close`
 * never fires (a task cannot finish, a `task_output block:true` waits its full
 * timeout) and in a one-shot run the open pipe keeps node alive until the
 * orphan exits (LIFECYCLE-REVIEW-2026-09-06 M2, measured: 3 min 21 s on a
 * `tail -f | cat`).
 *
 * `spawnOwnedTree` is the one way to start such a child. It takes the caller's
 * spawn call (so each site keeps its own launch: `commandLaunch`'s Windows
 * shims, `spawnShellCommand`), starts it `detached` (its own process group;
 * `detachedSpawnOptions`), remembers the group (`rememberProcessGroup`), and
 * returns the child with the tree's stop policy:
 *
 * - `stop` (`stopProcessTree`): SIGTERM now, SIGKILL to the group when the
 *   grace ends, whether or not the leader is still alive. The leader is often
 *   only a wrapper, which dies on TERM at once while what it forked (a dev
 *   server in its graceful-shutdown handler) keeps the group and its port; a
 *   leader-only check skipped the SIGKILL exactly then
 *   (LIFECYCLE-BACKGROUND-REVIEW-2026-09-26 M1, measured). A group whose
 *   SIGKILL is still pending when the process exits (pi's quit calls
 *   `process.exit`, and the grace timer is unref'd) is SIGKILLed from a
 *   `process.on("exit")` hook.
 * - `end` (`endProcessTree`): a bounded wait for the leader to exit on its
 *   own, then `stop`, then wait (bounded) until the group is empty; how a
 *   language server stops and an MCP server closes, since the leader's exit is
 *   not its tree's and a replacement must not start beside it.
 * - `kill` (`killProcessTree`): one signal to the whole group (falling back to
 *   the child alone when the group is already gone); `taskkill /T /F` on
 *   Windows, which has no groups.
 * - `endGroupWithLauncher`: when the leader exits, by itself or on a stop, the
 *   rest of its group is stopped too. A launcher-fronted server (LSP, MCP)
 *   needs it; a background shell does not, because the daemons a finished
 *   shell leaves are deliberate.
 *
 * A remembered group is owned for the lifetime of this process, including
 * what a successfully exited leader left behind; session replacement must not
 * kill those intentionally launched daemons. Each module instance keeps its
 * own groups through process listeners (never through a session context or
 * cross-extension module state), forgets a group once it is empty (probed when
 * its leader exits, then polled while the leader's leftovers live), and on
 * process exit or a termination signal sends TERM synchronously and leaves a
 * watchdog to SIGKILL what outlasts the grace, so nothing One Code owns
 * outlives the process.
 *
 * `waitForChildExit` is the counterpart on the waiting side: it settles on
 * `exit` plus a short stdio grace, never on `close` alone: a descendant the
 * kill missed (Windows: a process the `taskkill /T` snapshot did not see) can
 * hold the inherited pipes open for as long as it lives, and the task must not
 * wait for it (pi's `waitForChildProcess` has the same shape and reason).
 * Short-lived children that a caller awaits (hooks, the bash tool, `!`
 * expansions) use it with `detachedSpawnOptions` and `killProcessTree`
 * directly; they are not owned past their wait.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { system32Path } from "../profile/paths.ts";
import { brandedId, envName } from "../profile/brand.mjs";

/** SIGTERM → SIGKILL grace for a stopped tree (background shells, monitors, what a language or MCP server leaves). */
export const KILL_GRACE_MS = 2_000;

/** After `exit`, how long buffered stdio may keep arriving before the wait settles. */
export const EXIT_STDIO_GRACE_MS = 200;

/** ...and the most it may keep arriving in total: a straggler writing continuously must not keep re-arming the grace. */
export const EXIT_STDIO_MAX_MS = 2_000;

/**
 * Unref a child process, one of its stdio streams or a timer, so it never
 * holds the event loop open on its own (a finished one-shot run can exit);
 * a caller awaiting it holds its own ref. Child pipes are sockets at run
 * time and carry `unref()` even though their stream types do not declare it.
 */
export function unrefHandle(handle: unknown): void {
	(handle as { unref?: () => void } | null | undefined)?.unref?.();
}

/**
 * `detached` everywhere but Windows, where process groups do not exist — except
 * for a child that must outlive an exiting parent (a fire-and-forget hook),
 * which is what `detached: true` means on Windows (Node's documented use); the
 * leader is still killed by pid there.
 */
export function detachedSpawnOptions(opts: { outlivesParent?: boolean } = {}): { detached: boolean } {
	return { detached: process.platform !== "win32" || Boolean(opts.outlivesParent) };
}

/**
 * Windows has no process groups and no SIGTERM: `taskkill /T /F` ends the
 * tree by pid (the same call pi's own `killProcessTree` makes), from System32
 * so a PATH entry cannot substitute the binary. Whatever taskkill reports, the
 * leader itself is then terminated directly too — taskkill can fail to kill
 * (or to find) a member, and the leader's exit is what the waiting side keys
 * on. `ONECODE_DEBUG_KILL=1` logs taskkill's output to stderr.
 */
function taskkillTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid == null) return;
	const direct = () => {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	};
	try {
		const proc = execFile(system32Path("taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, (error, stdout, stderr) => {
			if (process.env[envName("DEBUG_KILL")]) {
				process.stderr.write(`[process-tree] taskkill /T /F /PID ${pid}: ${error ? `error ${error.message}` : "ok"}\n${stdout}${stderr}`);
			}
			direct();
		});
		proc.unref();
	} catch {
		direct();
	}
}

/**
 * Signal the whole group, frozen first. A group signal is not delivered to
 * every member at once: the command can die while its shell has not been
 * signalled yet, and the shell then reaps it and runs on, to the next command
 * of a cancelled hook (`sleep 2; touch done`) or to bash's "Terminated: 15"
 * job report (measured on macOS under load: 6 of 240 SIGKILLed shells ran
 * their next command, 28 wrote the report; none of 240 once frozen first).
 * SIGSTOP ends no process, so no parent wakes to act; the signal then lands
 * on a stopped group, and SIGCONT lets a member with a handler run it (a
 * stopped process takes its pending signal before any of its own code).
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	if (child.pid == null) return;
	if (process.platform === "win32") {
		taskkillTree(child);
		return;
	}
	const group = -child.pid;
	let frozen = false;
	try {
		process.kill(group, "SIGSTOP");
		frozen = true;
	} catch {
		// The group is gone, or cannot be stopped: signal it as it is.
	}
	let signalled = true;
	try {
		process.kill(group, signal);
	} catch {
		signalled = false;
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
	// A group the signal did not reach must not be left stopped, SIGKILL included.
	if (!frozen || (signalled && signal === "SIGKILL")) return;
	try {
		process.kill(group, "SIGCONT");
	} catch {
		// Every member died of the signal.
	}
}

/** Marks this module's signal handlers (every module instance's) apart from other listeners. */
const OWN_SIGNAL_HANDLER = Symbol.for(brandedId("process-tree-signal-handler"));

/**
 * signal-exit observers on the process (v3 keeps its count on
 * `process.__signal_exit_emitter__`, v4 under a global symbol). Each one
 * re-raises a signal once only its own listeners are left, so the process
 * still dies of it: they do not keep it running.
 */
function signalExitObservers(): number {
	const v3 = (process as { __signal_exit_emitter__?: { count?: number } }).__signal_exit_emitter__?.count ?? 0;
	const v4 = (globalThis as Record<symbol, { count?: number } | undefined>)[Symbol.for("signal-exit emitter")]?.count ?? 0;
	return v3 + v4;
}

/**
 * Whether a listener other than ours and signal-exit's takes `signal`: pi's
 * own SIGTERM/SIGHUP shutdown (which ends in `process.exit`, so the exit hook
 * runs), or one that keeps the process running.
 */
function signalHandledElsewhere(signal: NodeJS.Signals): boolean {
	const foreign = process.listeners(signal).filter((listener) => !(listener as { [OWN_SIGNAL_HANDLER]?: true })[OWN_SIGNAL_HANDLER]);
	return foreign.length > signalExitObservers();
}

/** Groups owned by this producer, retained by process listeners across session replacement. */
const rememberedGroups = new Set<ChildProcess>();
/** Polls the remembered groups while one is a live orphan (its leader exited, members still running). */
let orphanReaper: NodeJS.Timeout | undefined;
const terminationSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const groupSignalHandlers = new Map<NodeJS.Signals, () => void>();

/**
 * Whether a remembered tree still needs killing at exit. Windows has no
 * process groups, so only a live leader is worth a `taskkill /T`; it is judged
 * by the child's own exit state, because once the leader exits Windows may
 * hand its pid to an unrelated process that a pid probe would then find. On
 * POSIX a group id stays reserved while any member lives, and an emptied group
 * is forgotten when its leader exits or within a second of its last member
 * (`reapGroups`), far sooner than sequential pid allocation wraps around to it.
 */
export function rememberedGroupAlive(child: ChildProcess): boolean {
	if (child.pid == null) return false;
	if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Whether this process has seen the leader exit (Node reaped it: it is no zombie holding the group). */
function leaderExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Forget every remembered group whose leader has exited and that is now
 * empty, and drop the process listeners once none is left. Runs when a
 * leader exits; while a group outlives its leader (a finished shell's
 * daemon, a launcher's server until its stop lands) an unref'd one-second
 * poll keeps running, and only then: a group with a live leader is probed
 * again when that leader exits.
 */
function reapGroups(): void {
	for (const child of rememberedGroups) {
		if (leaderExited(child) && !rememberedGroupAlive(child)) rememberedGroups.delete(child);
	}
	if (rememberedGroups.size === 0) {
		releaseGroupListeners();
		return;
	}
	const orphans = [...rememberedGroups].some(leaderExited);
	if (orphans && !orphanReaper) {
		orphanReaper = setInterval(reapGroups, 1_000);
		orphanReaper.unref?.();
	} else if (!orphans && orphanReaper) {
		clearInterval(orphanReaper);
		orphanReaper = undefined;
	}
}

function releaseGroupListeners(): void {
	if (orphanReaper) clearInterval(orphanReaper);
	orphanReaper = undefined;
	process.removeListener("exit", terminateRememberedGroups);
	for (const [signal, handler] of groupSignalHandlers) process.removeListener(signal, handler);
	groupSignalHandlers.clear();
}

/**
 * The watchdog `killAfterExit` starts, as a `node -e` script: argv is the
 * grace in ms, then the group ids. It exits as soon as every group is gone,
 * and SIGKILLs what is left when the grace runs out.
 */
const EXIT_WATCHDOG = [
	"const [grace, ...groups] = process.argv.slice(1).map(Number);",
	"const alive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };",
	"const poll = setInterval(() => { if (!groups.some(alive)) process.exit(0); }, 50);",
	"setTimeout(() => { clearInterval(poll); for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch {} } }, grace);",
].join("\n");

/** How long an exiting process waits, blocking, for groups it just sent SIGTERM to empty before it leaves the rest to the watchdog. */
const EXIT_TERM_WAIT_MS = 25;
const EXIT_TERM_POLL_MS = 5;

/** Block this thread for `ms` (an exit handler cannot await). */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The process is exiting and the groups in `children` were just sent SIGTERM.
 * An exit handler cannot wait out a grace period, so a member that ignores or
 * outlasts SIGTERM (a server stuck in its shutdown handler) would outlive the
 * process: a small detached watchdog, started synchronously (the spawn
 * happens before `spawn` returns), SIGKILLs the groups still there after
 * `KILL_GRACE_MS` and exits as soon as none is. It names groups only: a group
 * id stays reserved while any member lives, so it cannot reach a stranger.
 * POSIX only; Windows' taskkill /F is already forceful.
 *
 * Most groups die of the SIGTERM at once, so when every leader has already
 * exited (a finished shell's daemons) the handler first waits, blocking, up
 * to `EXIT_TERM_WAIT_MS` and starts the watchdog only for the groups still
 * there. A leader this process has not reaped (still running, or dead with
 * its exit not yet handled) is a zombie until this process exits, and a
 * zombie keeps its group probeable, so a group with such a leader cannot be
 * judged here: it goes to the watchdog without the wait.
 */
function killAfterExit(children: ChildProcess[]): void {
	let live = children.filter((child) => child.pid != null);
	if (process.platform === "win32" || live.length === 0) return;
	if (live.every(leaderExited)) {
		for (let waited = 0; waited < EXIT_TERM_WAIT_MS && live.length > 0; waited += EXIT_TERM_POLL_MS) {
			sleepSync(EXIT_TERM_POLL_MS);
			live = live.filter(rememberedGroupAlive);
		}
		if (live.length === 0) return;
	}
	const groups = live.map((child) => child.pid as number);
	try {
		const watchdog = spawn(process.execPath, ["-e", EXIT_WATCHDOG, String(KILL_GRACE_MS), ...groups.map(String)], {
			detached: true,
			stdio: "ignore",
			env: {},
		});
		watchdog.unref();
	} catch {
		// Best effort at exit: the SIGTERM above has gone out regardless.
	}
}

/**
 * SIGTERM every remembered group still running, at exit or on a terminating
 * signal, and leave a watchdog to SIGKILL what outlasts the grace (an exit
 * handler cannot await it). A tree stopped earlier whose grace is still
 * running (`pendingKills`: an MCP server closed just before a one-shot run
 * exits) already has its SIGTERM: it joins the watchdog without a second
 * one, so it gets the same grace as a tree never stopped.
 */
function terminateRememberedGroups(): void {
	const live = [...new Set([...rememberedGroups, ...pendingKills])].filter(rememberedGroupAlive);
	for (const child of live) if (!pendingKills.has(child)) killProcessTree(child, "SIGTERM");
	rememberedGroups.clear();
	pendingKills.clear();
	releaseGroupListeners();
	killAfterExit(live);
}

/**
 * Remember a detached tree from spawn until its group becomes empty
 * (`spawnOwnedTree` calls it; a long-lived child is never remembered alone).
 * Register before awaiting its leader, so even immediate process exit covers
 * running work. The unref'd orphan poll cannot keep a print run alive. No
 * session shutdown handler touches this set; the process listeners keep this
 * module instance alive, and reach its set, even after pi evaluates the module
 * again (a /reload, a /resume into another directory: findings §8).
 */
function rememberProcessGroup(child: ChildProcess): void {
	if (child.pid == null || rememberedGroups.has(child)) return;
	rememberedGroups.add(child);
	child.once("exit", reapGroups);
	if (groupSignalHandlers.size > 0) return;
	process.on("exit", terminateRememberedGroups);
	for (const signal of terminationSignals) {
		const handler = Object.assign(
			() => {
				// Someone else takes the signal: the process is not dying of it
				// here. Leave the groups to the exit hook, which runs if it does
				// exit, and listen again once this dispatch is over. Ending them
				// now killed the language servers and background shells of a
				// process that kept running (the exit probe's held SIGINT).
				if (signalHandledElsewhere(signal)) {
					setImmediate(() => {
						if (groupSignalHandlers.get(signal) === handler) process.prependOnceListener(signal, handler);
					});
					return;
				}
				terminateRememberedGroups();
				// Do not swallow Node's default signal termination when there is no
				// pi handler. With isolated producers, the last listener re-raises it.
				if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
			},
			{ [OWN_SIGNAL_HANDLER]: true as const },
		);
		groupSignalHandlers.set(signal, handler);
		// Run before signal-exit observers: after we remove ourselves they must
		// still see the original listener count and preserve default termination.
		process.prependOnceListener(signal, handler);
	}
}

/**
 * Trees sent SIGTERM whose SIGKILL has not run yet. Keyed by the child, not
 * its pid, so a pid the OS hands to a new child during the grace does not
 * make that child look already scheduled. Per module instance on purpose
 * (each extension force-kills its own children). Every one is an owned tree,
 * so the remembered groups' exit hook covers it (`terminateRememberedGroups`).
 */
const pendingKills = new Set<ChildProcess>();

/**
 * SIGTERM the tree, then SIGKILL the whole group after `graceMs`, whatever
 * the leader's state: a group already gone makes that an ESRCH, and a live
 * group keeps its id reserved, so the id cannot name anyone else. The timer
 * is unref'd (it must never be what keeps a one-shot process alive); a
 * process exit before it fires hands the group to the exit watchdog. A tree
 * already in its grace is left to it: a second SIGTERM (with its SIGSTOP and
 * SIGCONT) could land in a server's shutdown handler.
 */
function stopProcessTree(child: ChildProcess, graceMs: number): void {
	if (pendingKills.has(child)) return;
	killProcessTree(child, "SIGTERM");
	// taskkill /F is already forceful; there is no gentler first signal to grace.
	if (process.platform === "win32") return;
	if (child.pid == null) return;
	pendingKills.add(child);
	const timer = setTimeout(() => {
		if (!pendingKills.delete(child)) return;
		killProcessTree(child, "SIGKILL");
	}, graceMs);
	timer.unref?.();
}

/** How often `endProcessTree` checks whether the stopped group has emptied. */
const GROUP_POLL_MS = 50;
/** How long `endProcessTree` waits past the TERM grace for the SIGKILLed group to empty. */
export const KILL_SETTLE_MS = 250;

/** The longest `endProcessTree(child, graceMs, leaderMs)` takes: the leader's grace, the TERM grace and the SIGKILL's settling. */
export const endTreeMaxMs = (graceMs: number, leaderMs = 0): number => leaderMs + graceMs + KILL_SETTLE_MS;

/**
 * Give the leader up to `leaderMs` to exit on its own (after a polite close:
 * stdin ended, a protocol `exit`), then stop the tree (`stopProcessTree`) and
 * resolve once it has no member left (`endTreeMaxMs` bounds the whole wait).
 * A leader's exit is not its tree's: a launcher's server lives on through its
 * TERM grace (or a whole grace, if it ignores TERM), and what replaces it must
 * not start beside it. On Windows the tree is its leader
 * (`rememberedGroupAlive`).
 */
async function endProcessTree(child: ChildProcess, graceMs: number, leaderMs = 0): Promise<void> {
	if (leaderMs > 0 && !leaderExited(child)) {
		await new Promise<void>((resolve) => {
			const settle = () => {
				clearTimeout(timer);
				child.off("exit", settle);
				resolve();
			};
			const timer = setTimeout(settle, leaderMs);
			timer.unref();
			child.once("exit", settle);
		});
	}
	if (!rememberedGroupAlive(child)) return;
	stopProcessTree(child, graceMs);
	// A deadline, not a count of polls: a loaded machine fires each poll late, and the
	// MCP client's close timeout is built from this bound (endTreeMaxMs).
	const deadline = Date.now() + graceMs + KILL_SETTLE_MS;
	while (rememberedGroupAlive(child) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, GROUP_POLL_MS).unref());
	}
}

/** A long-lived child in its own process group, owned until this process exits, and how to end its tree. */
export interface OwnedTree {
	readonly child: ChildProcess;
	/** SIGTERM the tree now and SIGKILL its group after `graceMs`; a tree already stopping is left to that stop (`stopProcessTree`). */
	stop(graceMs: number): void;
	/** Wait up to `leaderMs` for the leader to exit, then `stop` and resolve once no member is left, at most `endTreeMaxMs` (`endProcessTree`). */
	end(graceMs: number, leaderMs?: number): Promise<void>;
	/** Send one signal to the whole tree, with no grace (`killProcessTree`). */
	kill(signal: NodeJS.Signals): void;
	/** Whether the tree still has a member to end (`rememberedGroupAlive`). */
	alive(): boolean;
}

export interface OwnedTreeOptions {
	/**
	 * When the leader exits, by itself or on a stop, stop the rest of its
	 * group (SIGTERM, SIGKILL after `KILL_GRACE_MS`). For a launcher in front of
	 * the real process (a language or MCP server's script, `npx`, a `.cmd`
	 * shim), which can exit and leave the server running. Off for a background
	 * shell: what a finished shell leaves behind is deliberate and lives until
	 * the process exits.
	 */
	endGroupWithLauncher?: boolean;
}

/**
 * Start a long-lived child as an owned tree: `start` makes the spawn call
 * with the given options spread into its own (on POSIX they make the child
 * the leader of a new process group; Windows has none, and the tree is
 * reached through its leader), and the group is remembered at once, so the
 * process's exit and termination-signal hooks end it even if nothing else
 * does. Every long-lived spawner goes through here (test/unit/process-spawners.test.ts).
 */
export function spawnOwnedTree(start: (detached: { detached: boolean }) => ChildProcess, options: OwnedTreeOptions = {}): OwnedTree {
	const child = start(detachedSpawnOptions());
	rememberProcessGroup(child);
	if (options.endGroupWithLauncher) {
		child.on("exit", () => {
			if (rememberedGroupAlive(child)) stopProcessTree(child, KILL_GRACE_MS);
		});
	}
	return {
		child,
		stop: (graceMs) => stopProcessTree(child, graceMs),
		end: (graceMs, leaderMs) => endProcessTree(child, graceMs, leaderMs),
		kill: (signal) => killProcessTree(child, signal),
		alive: () => rememberedGroupAlive(child),
	};
}

export interface ChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * Resolve when the child has exited and its stdio has drained: on `close`
 * when that arrives promptly, else `EXIT_STDIO_GRACE_MS` after `exit` (the
 * grace re-arms while output is still arriving, so a burst written just before
 * exit is not cut) and `EXIT_STDIO_MAX_MS` after `exit` at the latest (a
 * descendant the kill missed that keeps writing must not hold the wait).
 * Rejects on a spawn `error`. Listeners the caller attached for `data` keep
 * working; the streams are destroyed once this settles so a straggler holding
 * the far end cannot keep them — or the process — alive.
 */
export function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited: ChildExit | undefined;
		let grace: NodeJS.Timeout | undefined;
		let deadline: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (grace) clearTimeout(grace);
			if (deadline) clearTimeout(deadline);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finish = () => {
			if (settled || !exited) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(exited);
		};
		const arm = () => {
			if (grace) clearTimeout(grace);
			// Ref'd on purpose: in a one-shot run this timer may be the only handle
			// left once the pipes have closed, and the promise must still settle.
			grace = setTimeout(finish, EXIT_STDIO_GRACE_MS);
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			exited = { code, signal };
			arm();
			deadline = setTimeout(finish, EXIT_STDIO_MAX_MS);
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			exited ??= { code, signal };
			finish();
		};
		const onData = () => {
			if (exited && !settled) arm();
		};
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
	});
}
