import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BashFinishSummary,
	EMPTY_OUTPUT_MARKER,
	startBackgroundBash,
	tailCap,
} from "../../extensions/bash/background.ts";
import type { BackgroundTask } from "../../extensions/background/registry.ts";

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
		const { task, summary } = start("sleep 30", { timeoutSeconds: 0.2 });
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
