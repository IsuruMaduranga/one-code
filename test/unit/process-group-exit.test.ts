/**
 * What a remembered process group (lib/shell-run/process-tree.ts) does when
 * its owner process ends: a member that ignores SIGTERM is SIGKILLed after the
 * grace, whether the owner quits, crashes or dies of a signal. The owner is a
 * separate Node process running a background shell that leaves a worker
 * behind, as a dev server's supervisor does.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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

