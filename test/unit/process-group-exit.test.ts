/**
 * What a remembered process group (lib/shell-run/process-tree.ts) does when
 * its owner process ends: a member that ignores SIGTERM is SIGKILLed after the
 * grace, whether the owner quits, crashes or dies of a signal. The owner is a
 * separate Node process running a background shell that leaves a worker
 * behind, as a dev server's supervisor does.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KILL_GRACE_MS } from "../../extensions/lib/shell-run/process-tree.ts";
import { alive, until } from "./helpers/process-alive.ts";

/** A worker that ignores SIGTERM (and SIGHUP, SIGINT), left by a shell that has finished. */
const STUBBORN_WORKER = `(trap '' TERM HUP INT; exec sleep 60) & printf "%s %s\\n" "$$" "$!"`;

interface Owner {
	worker: number;
	group: number;
	owner: ReturnType<typeof spawn>;
	exited: Promise<unknown[]>;
	cleanup(): void;
}

/** Start an owner that runs `command` as a background shell, then does `onInput` when written to. */
async function startOwner(command: string, onInput: string, preamble = ""): Promise<Owner> {
	const moduleUrl = pathToFileURL(resolve("extensions/lib/shell-run/bash-background.ts")).href;
	const script = [
		`import { runBackgroundBashBlocking } from ${JSON.stringify(moduleUrl)};`,
		preamble,
		`setInterval(() => {}, 1000);`,
		`const result = await runBackgroundBashBlocking({ text: { earlierTruncated: '', spoolLost: () => '', emptyOutput: '' }, id: 'exit-test', command: ${JSON.stringify(command)}, description: 'worker', cwd: process.cwd() });`,
		`process.stdout.write(result.output);`,
		`process.stdin.on('data', () => { ${onInput} });`,
	].join("\n");
	const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
	const exited = once(owner, "exit");
	let error = "";
	owner.stderr.on("data", (chunk) => {
		error += chunk;
	});
	const [chunk] = await Promise.race([once(owner.stdout, "data"), exited.then(() => Promise.reject(new Error(`owner exited before ready: ${error}`)))]);
	const [group, worker] = String(chunk).trim().split(/\s+/).map(Number);
	return {
		worker,
		group,
		owner,
		exited,
		cleanup: () => {
			if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
			for (const target of [-group, worker]) {
				try {
					process.kill(target, "SIGKILL");
				} catch {
					// Gone.
				}
			}
		},
	};
}

/** Polls for the grace plus a margin. */
const goneAfterGrace = (pid: number) => until(() => !alive(pid), Math.ceil((KILL_GRACE_MS + 2_000) / 50));

describe.skipIf(process.platform === "win32")("a remembered group when its owner ends", () => {
	it.each([
		["quits", "process.exit(0);", undefined],
		["crashes", "throw new Error('crash');", undefined],
		["dies of SIGINT", "", "SIGINT"],
		["dies of SIGTERM", "", "SIGTERM"],
	] as const)("SIGKILLs a member that ignores SIGTERM after the grace when the owner %s", async (_, onInput, signal) => {
		const run = await startOwner(STUBBORN_WORKER, onInput);
		try {
			expect(alive(run.worker)).toBe(true);
			if (signal) run.owner.kill(signal);
			else run.owner.stdin!.write("go\n");
			await run.exited;
			// SIGTERM alone leaves it running: it is still there right after the owner.
			expect(alive(run.worker)).toBe(true);
			expect(await goneAfterGrace(run.worker)).toBe(true);
		} finally {
			run.cleanup();
		}
	}, 15_000);
});

/** A worker that ends on SIGTERM, left by a shell that has finished. */
const WORKER = `sleep 60 & printf "%s %s\\n" "$$" "$!"`;

/**
 * Logs every exit watchdog the owner starts (a `node -e` spawn) to `log`, one
 * line of group ids each: the owner's `node:child_process` exports are patched
 * and synced into the ES module bindings process-tree.ts imported.
 */
const logWatchdogs = (log: string) =>
	[
		`import { createRequire, syncBuiltinESMExports } from "node:module";`,
		`import { appendFileSync } from "node:fs";`,
		`const childProcess = createRequire(import.meta.url)("node:child_process");`,
		`const spawnBefore = childProcess.spawn;`,
		`childProcess.spawn = function (command, args, ...rest) { if (args?.[0] === "-e") appendFileSync(${JSON.stringify(log)}, args.slice(3).join(" ") + "\\n"); return spawnBefore.call(this, command, args, ...rest); };`,
		`syncBuiltinESMExports();`,
	].join("\n");

describe.skipIf(process.platform === "win32")("the exit watchdog", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "exit-watchdog-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const watchdogs = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

	it("is not started when every group ends on the SIGTERM", async () => {
		const log = join(dir, "watchdogs.log");
		const run = await startOwner(WORKER, "process.exit(0);", logWatchdogs(log));
		try {
			run.owner.stdin!.write("go\n");
			await run.exited;
			expect(await until(() => !alive(run.worker))).toBe(true);
			expect(watchdogs(log)).toEqual([]);
		} finally {
			run.cleanup();
		}
	}, 15_000);

	it("is started for a group that outlasts the SIGTERM, naming that group", async () => {
		const log = join(dir, "watchdogs.log");
		const run = await startOwner(STUBBORN_WORKER, "process.exit(0);", logWatchdogs(log));
		try {
			run.owner.stdin!.write("go\n");
			await run.exited;
			expect(watchdogs(log)).toEqual([String(run.group)]);
			expect(await goneAfterGrace(run.worker)).toBe(true);
		} finally {
			run.cleanup();
		}
	}, 15_000);
});

/**
 * pi's bundle loads signal-exit v3 (through proper-lockfile) as the owner
 * imports it: one listener per signal, which re-raises the signal once only
 * signal-exit's own listeners are left. The owner checks it is there.
 */
const SIGNAL_EXIT_LOADED = `if (!process.__signal_exit_emitter__?.count || process.listenerCount("SIGINT") < 1) throw new Error("signal-exit is not listening");`;

describe.skipIf(process.platform === "win32")("a remembered group when its owner survives a signal", () => {
	it("is left running when another listener keeps the owner alive, and ended when the owner exits", async () => {
		const run = await startOwner(WORKER, "process.exit(0);", `process.on("SIGINT", () => {});`);
		try {
			run.owner.kill("SIGINT");
			await new Promise((resolveWait) => setTimeout(resolveWait, 500));
			expect(run.owner.exitCode).toBe(null);
			expect(alive(run.worker)).toBe(true);
			// Still listening: a second held SIGINT changes nothing either.
			run.owner.kill("SIGINT");
			await new Promise((resolveWait) => setTimeout(resolveWait, 300));
			expect(alive(run.worker)).toBe(true);

			run.owner.stdin!.write("go\n");
			await run.exited;
			expect(await until(() => !alive(run.worker))).toBe(true);
		} finally {
			run.cleanup();
		}
	}, 15_000);

	it("is ended when a signal-exit observer re-raises the signal", async () => {
		const run = await startOwner(WORKER, "", SIGNAL_EXIT_LOADED);
		try {
			run.owner.kill("SIGINT");
			const [, signal] = await run.exited;
			expect(signal).toBe("SIGINT");
			expect(await until(() => !alive(run.worker))).toBe(true);
		} finally {
			run.cleanup();
		}
	}, 15_000);
});
