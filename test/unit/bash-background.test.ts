import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BashFinishSummary,
	EMPTY_OUTPUT_MARKER,
	runBackgroundBashBlocking,
	startBackgroundBash,
	tailCap,
} from "../../extensions/bash/background.ts";
import type { BackgroundTask } from "../../extensions/background/registry.ts";
import { localPwsh } from "./helpers/local-pwsh.ts";

function start(command: string, extra?: { timeoutSeconds?: number; logPath?: string }) {
	let summary: BashFinishSummary | undefined;
	const task = startBackgroundBash({
		id: "btest001",
		command,
		description: "test",
		cwd: process.cwd(),
		...extra,
		onFinished: (_task: BackgroundTask, s) => {
			summary = s;
		},
	});
	return { task, summary: () => summary };
}

describe("startBackgroundBash", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("completes with the command's output and exit code", async () => {
		const { task, summary } = start("echo hello-bg");
		await task.finished;
		expect(task.status).toBe("completed");
		expect(task.output()).toContain("hello-bg");
		expect(summary()?.exitCode).toBe(0);
		// The notification and task_output must never disagree.
		expect(summary()?.output).toBe(task.output());
	});

	it("captures stderr and marks a non-zero exit as failed", async () => {
		const { task, summary } = start("echo oops 1>&2; exit 3");
		await task.finished;
		expect(task.status).toBe("failed");
		expect(task.output()).toContain("oops");
		expect(summary()?.exitCode).toBe(3);
	});

	it("marks legitimately-empty output explicitly instead of returning a blank body", async () => {
		const { task, summary } = start("true");
		await task.finished;
		expect(task.status).toBe("completed");
		expect(task.output()).toBe(EMPTY_OUTPUT_MARKER);
		expect(summary()?.output).toBe(EMPTY_OUTPUT_MARKER);
	});

	it("stop() ends the run with status stopped", async () => {
		const { task, summary } = start("sleep 30");
		task.stop();
		await task.finished;
		expect(task.status).toBe("stopped");
		expect(summary()?.stopped).toBe(true);
	});

	it("kills the run when the timeout elapses and says it timed out", async () => {
		const { task, summary } = start("sleep 30", { timeoutSeconds: 0.5 });
		await task.finished;
		expect(task.status).toBe("failed");
		expect(summary()?.timedOut).toBe(true);
	});

	it("spools output to the log file", async () => {
		dir = mkdtempSync(join(tmpdir(), "cc-bash-bg-"));
		const logPath = join(dir, "output.log");
		const { task } = start("echo spooled", { logPath });
		await task.finished;
		expect(task.logPath).toBe(logPath);
		expect(readFileSync(logPath, "utf-8")).toContain("spooled");
	});
});

describe("tailCap", () => {
	it("keeps short text and truncates long text with a marker", () => {
		expect(tailCap("short", 100)).toBe("short");
		const capped = tailCap("x".repeat(500), 100);
		expect(capped).toContain("earlier output truncated");
		expect(capped.endsWith("x".repeat(100))).toBe(true);
	});
});

describe("runBackgroundBashBlocking (one-shot modes, STEERING-REVIEW-2026-09-05 H3)", () => {
	const options = (command: string) => ({ id: "bblock01", command, description: "test", cwd: process.cwd() });

	it("resolves with the finished command's summary and output", async () => {
		const summary = await runBackgroundBashBlocking(options("echo blocking-ok"));
		expect(summary.exitCode).toBe(0);
		expect(summary.stopped).toBe(false);
		expect(summary.output).toContain("blocking-ok");
	});

	it("stops the process tree when the tool's signal aborts and reports stopped", async () => {
		const controller = new AbortController();
		const pending = runBackgroundBashBlocking(options("sleep 30"), controller.signal);
		setTimeout(() => controller.abort(), 100);
		const summary = await pending;
		expect(summary.stopped).toBe(true);
	});

	it("stops immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const summary = await runBackgroundBashBlocking(options("sleep 30"), controller.signal);
		expect(summary.stopped).toBe(true);
	});
});

describe("startBackgroundBash stop escalation", () => {
	it("SIGKILLs a command that traps SIGTERM, so the task still finishes", async () => {
		// The shell ignores TERM and sleep inherits the disposition: a bare SIGTERM
		// never ended it, so `close` never fired and a blocking caller hung.
		const { task, summary } = start("trap '' TERM; sleep 30", { timeoutSeconds: 1 });
		await new Promise((r) => setTimeout(r, 150));
		const stopped = Date.now();
		task.stop();
		await task.finished;
		expect(task.status).toBe("stopped");
		expect(summary()?.stopped).toBe(true);
		expect(Date.now() - stopped).toBeLessThan(4000);
	}, 10_000);
});

const pwsh = localPwsh();

/**
 * The powershell extension runs its `run_in_background` through the same
 * starter with its own spawn spec; stop and timeout must end a PowerShell tree
 * the way they end a bash one (on Windows: taskkill /T /F, lib/process-tree.ts).
 */
describe.skipIf(!pwsh)("startBackgroundBash with a PowerShell spec (real pwsh)", { timeout: 45_000 }, () => {
	const startPwsh = (command: string, extra?: { timeoutSeconds?: number }) => {
		let summary: BashFinishSummary | undefined;
		const task = startBackgroundBash({
			id: "bpwsh001",
			command,
			description: "test",
			cwd: process.cwd(),
			shell: pwsh,
			...extra,
			onFinished: (_task: BackgroundTask, s) => {
				summary = s;
			},
		});
		return { task, summary: () => summary };
	};
	const settled = (task: BackgroundTask) =>
		Promise.race([task.finished, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`task still ${task.status} after 30 s`)), 30_000))]);

	it("completes with the command's output", async () => {
		const { task } = startPwsh("Write-Output 'bg from pwsh'");
		await settled(task);
		expect(task.status).toBe("completed");
		expect(task.output()).toContain("bg from pwsh");
	});

	it("stop() ends the PowerShell tree and reports stopped", async () => {
		const { task, summary } = startPwsh("Start-Sleep -Seconds 60");
		await new Promise((r) => setTimeout(r, 300));
		task.stop();
		await settled(task);
		expect(task.status).toBe("stopped");
		expect(summary()?.stopped).toBe(true);
	});

	it("kills a PowerShell run when the timeout elapses and says it timed out", async () => {
		const { task, summary } = startPwsh("Start-Sleep -Seconds 60", { timeoutSeconds: 1 });
		await settled(task);
		expect(task.status).toBe("failed");
		expect(summary()?.timedOut).toBe(true);
	});
});
