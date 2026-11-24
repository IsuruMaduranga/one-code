import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detachable, ForegroundRun, type ShellOperations } from "../../extensions/lib/shell-run/foreground-run.ts";

const text = { earlierTruncated: "[earlier output truncated]\n", spoolLost: () => "[lost]", emptyOutput: "(no output)" };

/** Operations whose one command the test drives: it prints, then exits or is aborted. */
function fakeOperations() {
	let print!: (line: string) => void;
	let exit!: (code: number) => void;
	const seen: { timeout?: number; signal?: AbortSignal } = {};
	const inner: ShellOperations = {
		exec: (_command, _cwd, options) =>
			new Promise((resolve, reject) => {
				seen.timeout = options.timeout;
				seen.signal = options.signal;
				print = (line) => options.onData(Buffer.from(line));
				exit = (exitCode) => resolve({ exitCode });
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	};
	return { inner, seen, print: (line: string) => print(line), exit: (code: number) => exit(code) };
}

describe("a detachable foreground run", () => {
	let dir: string;
	let logPath: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "foreground-run-"));
		logPath = join(dir, "b1.output");
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	const start = (run: ForegroundRun, ops: ShellOperations, timeout?: number) => {
		const shown: string[] = [];
		const result = detachable(ops).exec("cmd", dir, { onData: (data) => shown.push(String(data)), signal: run.signal, timeout });
		result.catch(() => {});
		return { shown, result };
	};

	it("passes a call no run was started for straight through", async () => {
		const fake = fakeOperations();
		const signal = new AbortController().signal;
		const result = detachable(fake.inner).exec("cmd", dir, { onData: () => {}, signal, timeout: 5 });
		expect(fake.seen).toEqual({ timeout: 5, signal });
		fake.exit(0);
		expect(await result).toEqual({ exitCode: 0 });
	});

	it("ends in the foreground with the command's exit code, and leaves no output file", async () => {
		const fake = fakeOperations();
		const run = new ForegroundRun(logPath, text);
		const { shown, result } = start(run, fake.inner, 5);
		expect(run.running).toBe(true);
		expect(fake.seen.timeout).toBeUndefined();
		fake.print("one\n");
		fake.exit(3);
		expect(await result).toEqual({ exitCode: 3 });
		expect(shown).toEqual(["one\n"]);
		expect(run.detach()).toBe(false);
		await run.discard();
		expect(existsSync(logPath)).toBe(false);
	});

	it("writes the output file from the first byte, and keeps writing it after a detach", async () => {
		const fake = fakeOperations();
		const run = new ForegroundRun(logPath, text);
		const { shown, result } = start(run, fake.inner);
		fake.print("before\n");
		expect(run.detach()).toBe(true);
		await expect(result).rejects.toThrow("aborted");
		await run.detached;
		fake.print("after\n");
		fake.exit(0);
		expect(await run.ended).toEqual({ exitCode: 0, stopped: false });
		expect(shown).toEqual(["before\n"]);
		expect(readFileSync(logPath, "utf8")).toBe("before\nafter\n");
		expect(run.output()).toBe("before\nafter\n");
		expect(run.outputFile()).toBe(logPath);
	});

	it("stops following the caller's abort and the deadline once detached", async () => {
		vi.useFakeTimers();
		const fake = fakeOperations();
		const caller = new AbortController();
		const run = new ForegroundRun(undefined, text, caller.signal);
		start(run, fake.inner, 2);
		run.detach();
		caller.abort();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.seen.signal?.aborted).toBe(false);
		run.stop();
		expect(await run.ended).toEqual({ exitCode: null, stopped: true });
	});

	it("stops the command on the caller's abort while attached", async () => {
		const fake = fakeOperations();
		const caller = new AbortController();
		const run = new ForegroundRun(undefined, text, caller.signal);
		const { result } = start(run, fake.inner);
		caller.abort();
		// A command already being stopped is not kept running in the background.
		expect(run.detach()).toBe(false);
		await expect(result).rejects.toThrow("aborted");
	});

	it("reports its own deadline as pi's timeout error", async () => {
		vi.useFakeTimers();
		const fake = fakeOperations();
		const run = new ForegroundRun(undefined, text);
		const { result } = start(run, fake.inner, 2);
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(result).rejects.toThrow("timeout:2");
	});

	it("never starts a command whose caller aborted first", async () => {
		const fake = fakeOperations();
		const caller = new AbortController();
		caller.abort();
		const run = new ForegroundRun(undefined, text, caller.signal);
		await expect(start(run, fake.inner).result).rejects.toThrow("aborted");
		expect(fake.seen.signal).toBeUndefined();
		expect(run.detach()).toBe(false);
	});
});
