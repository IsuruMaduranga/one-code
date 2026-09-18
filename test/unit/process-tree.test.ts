/**
 * lib/process-tree.ts against real shells (the repo never mocks child_process).
 * With zsh as $SHELL, `cmd; echo` and pipelines run the command outside the
 * `$SHELL -c` leader; signalling the leader alone left them as orphans holding
 * the stdout pipe (LIFECYCLE-REVIEW-2026-09-06 M2). Detached spawn + group kill
 * ends the whole tree, so `close` fires promptly.
 */
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { detachedSpawnOptions, killProcessTree, stopProcessTree, waitForChildExit } from "../../extensions/lib/process-tree.ts";
import { bashSpawnOrThrow } from "../../extensions/lib/shell-spawn.ts";

// The shell One Code spawns: $SHELL here (zsh on macOS is the interesting
// case), the resolved bash — Git Bash — on Windows, where $SHELL is unset.
const bash = bashSpawnOrThrow();
const shell = process.platform === "win32" ? bash.shell : process.env.SHELL || bash.shell;

function spawnShell(command: string) {
	const child = spawn(shell, ["-c", command], { ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	if (process.platform === "win32") {
		// Windows diagnostics for the CI log: what the kill left behind.
		child.once("exit", () => setTimeout(() => console.log(`[process-tree] after kill of ${child.pid}:\n${survivors()}`), 300));
	}
	return child;
}

/** `tasklist` lines for the shells and sleeps still alive (Windows only). */
function survivors(): string {
	try {
		return execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
			.split(/\r?\n/)
			.filter((line) => /bash|sleep|cat\.exe/i.test(line))
			.join("\n");
	} catch (error) {
		return String(error);
	}
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

describe("killProcessTree", () => {
	it("ends a pipeline's members, not just the shell, so the stdout pipe closes at once", async () => {
		const child = spawnShell("sleep 30 | cat");
		await new Promise((r) => setTimeout(r, 100)); // let the shell fork the pipeline
		const closed = closeWithin(child, 3000);
		killProcessTree(child);
		expect(await closed).toBeLessThan(3000);
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

	it("ends a `cmd; more` sequence the same way", async () => {
		const child = spawnShell("sleep 30; echo done");
		await new Promise((r) => setTimeout(r, 100));
		const closed = closeWithin(child, 3000);
		killProcessTree(child);
		expect(await closed).toBeLessThan(3000);
	});
});

describe("stopProcessTree", () => {
	it("SIGKILLs after the grace period when the tree ignores SIGTERM", async () => {
		// The shell ignores TERM and the disposition is inherited by sleep.
		const child = spawnShell("trap '' TERM; sleep 30");
		await new Promise((r) => setTimeout(r, 150));
		const closed = closeWithin(child, 4000);
		stopProcessTree(child, 300);
		const elapsed = await closed;
		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(elapsed).toBeLessThan(4000);
	});
});
