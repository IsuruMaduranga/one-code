/**
 * lib/process-tree.ts against real shells (the repo never mocks child_process).
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
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detachedSpawnOptions, EXIT_STDIO_MAX_MS, killProcessTree, stopProcessTree, waitForChildExit } from "../../extensions/lib/process-tree.ts";
import { bashSpawnOrThrow } from "../../extensions/lib/shell-spawn.ts";

const win32 = process.platform === "win32";

// The shell One Code spawns: $SHELL here (zsh on macOS is the interesting
// case), the resolved bash — Git Bash — on Windows, where $SHELL is unset.
const bash = bashSpawnOrThrow();
const shell = win32 ? bash.shell : process.env.SHELL || bash.shell;

function spawnShell(command: string) {
	return spawn(shell, ["-c", command], { ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

describe("killProcessTree", () => {
	it("ends a pipeline's members, not just the shell, so the stdout pipe closes at once", async () => {
		const child = spawnShell("sleep 30 | cat");
		await new Promise((r) => setTimeout(r, 100)); // let the shell fork the pipeline
		const settled = settledWithin(child, 3000);
		killProcessTree(child);
		expect(await settled).toBeLessThan(3000);
	});

	it("ends a `cmd; more` sequence the same way", async () => {
		const child = spawnShell("sleep 30; echo done");
		await new Promise((r) => setTimeout(r, 100));
		const settled = settledWithin(child, 3000);
		killProcessTree(child);
		expect(await settled).toBeLessThan(3000);
	});

	it("waitForChildExit settles on exit plus the stdio grace, so a pipe a straggler holds cannot hang the wait", async () => {
		const child = spawnShell("sleep 30 | cat");
		await new Promise((r) => setTimeout(r, 100));
		const started = Date.now();
		const exited = waitForChildExit(child);
		killProcessTree(child);
		const { code, signal } = await exited;
		expect(Date.now() - started).toBeLessThan(3000);
		expect(code === null || code !== 0 || signal !== null).toBe(true);
	});

	it("waitForChildExit settles within the post-exit cap when a straggler keeps writing to the inherited pipe", async () => {
		// The leader exits at once; the backgrounded loop it left behind writes
		// every 50 ms, re-arming the stdio grace forever without the cap.
		const child = spawnShell("(while true; do echo x; sleep 0.05; done) & exit 0");
		const started = Date.now();
		await waitForChildExit(child);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(EXIT_STDIO_MAX_MS + 1500);
		killProcessTree(child, "SIGKILL"); // the loop is not the leader's group on Windows; best effort
	});
});

describe("stopProcessTree", () => {
	// Windows has no SIGTERM to ignore: taskkill /F is the first and only signal,
	// so the grace period does not exist there (lib/process-tree.ts).
	it.skipIf(win32)("SIGKILLs after the grace period when the tree ignores SIGTERM", async () => {
		// The shell ignores TERM and the disposition is inherited by sleep.
		const child = spawnShell("trap '' TERM; sleep 30");
		await new Promise((r) => setTimeout(r, 150));
		const closed = closeWithin(child, 4000);
		stopProcessTree(child, 300);
		const elapsed = await closed;
		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(elapsed).toBeLessThan(4000);
	});

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
	/** A group whose leader dies on TERM while a member it forked ignores TERM (the `bash -c` wrapper around a dev server). */
	const leaderDiesMemberResists = `sh -c 'trap "" TERM; while :; do sleep 0.2; done' & wait`;

	it.skipIf(win32)("SIGKILLs the group after the grace even when the leader died on SIGTERM and a member did not (A3-M1)", async () => {
		const child = spawn(bash.shell, ["-c", leaderDiesMemberResists], { ...detachedSpawnOptions(), stdio: "ignore" });
		const pgid = child.pid!;
		try {
			await new Promise((r) => setTimeout(r, 200)); // let the member start and set its trap
			const exited = new Promise((r) => child.once("exit", r));
			stopProcessTree(child, 300);
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

	it.skipIf(win32)("force-kills a stopped tree at process exit, before its grace timer could fire (A3-M1, the quit path)", async () => {
		// A throwaway node process stops its own TERM-resistant group and exits 50 ms
		// later, as pi's quit does (dispose, then process.exit).
		const moduleUrl = new URL(`file://${resolve("extensions/lib/process-tree.ts")}`).href;
		const script = [
			`import { spawn } from "node:child_process";`,
			`import { detachedSpawnOptions, stopProcessTree } from ${JSON.stringify(moduleUrl)};`,
			`const child = spawn(${JSON.stringify(bash.shell)}, ["-c", ${JSON.stringify(leaderDiesMemberResists)}], { ...detachedSpawnOptions(), stdio: "ignore" });`,
			`child.unref();`,
			`process.stdout.write(String(child.pid));`,
			`setTimeout(() => { stopProcessTree(child, 2000); setTimeout(() => process.exit(0), 50); }, 200);`,
		].join("\n");
		const stdout = await new Promise<string>((done, fail) =>
			execFile(process.execPath, ["--input-type=module", "-e", script], (error, out) => (error ? fail(error) : done(out))),
		);
		const pgid = Number(stdout.trim());
		expect(pgid).toBeGreaterThan(0);
		try {
			// Well inside the 2 s grace: only the exit hook can have killed it.
			expect(await waitUntilGone(pgid, 1000)).toBe(true);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});

	it("ends the tree at once where there is no gentler signal to grace (Windows)", async () => {
		const child = spawnShell("sleep 30");
		await new Promise((r) => setTimeout(r, 150));
		const settled = settledWithin(child, 4000);
		stopProcessTree(child, 300);
		expect(await settled).toBeLessThan(4000);
	});
});
