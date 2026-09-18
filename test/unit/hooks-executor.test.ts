import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runHookCommand } from "../../extensions/hooks/executor.ts";

// Real /bin/sh children, per the repo convention of never mocking
// child_process: keep spawn in a thin executor and test that executor live.
// realpath because macOS tmpdir lives behind a /var → /private/var symlink,
// and the child's pwd reports the resolved form.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-hooks-exec-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runHookCommand", () => {
	it("keeps the hook's child process ref'd while it runs, so a one-shot run cannot drain mid-hook (detached only on request)", async () => {
		// A ChildProcess exposes its ref state on the underlying libuv handle.
		type Handle = { constructor: { name: string }; _handle?: { hasRef?: () => boolean } };
		const childRefs = () =>
			(process as unknown as { _getActiveHandles(): Handle[] })
				._getActiveHandles()
				.filter((h) => h.constructor.name === "ChildProcess")
				.map((h) => h._handle?.hasRef?.());
		const before = childRefs().length;

		const awaited = runHookCommand("sleep 0.2", "{}", { cwd: process.cwd() });
		await new Promise((r) => setTimeout(r, 50));
		expect(childRefs().filter((ref) => ref === true).length).toBeGreaterThan(before);
		await awaited;

		const fireAndForget = runHookCommand("sleep 0.2", "{}", { cwd: process.cwd(), detached: true });
		await new Promise((r) => setTimeout(r, 50));
		// Unref'd: either absent from the active list or listed without a ref.
		expect(childRefs().filter((ref) => ref === true).length).toBe(before);
		await fireAndForget;
	});

	it("captures stdout, stderr, and the exit code", async () => {
		const result = await runHookCommand("echo out; echo err >&2; exit 3", "{}", { cwd: dir });
		expect(result.stdout.trim()).toBe("out");
		expect(result.stderr.trim()).toBe("err");
		expect(result.exitCode).toBe(3);
		expect(result.timedOut).toBe(false);
	});

	it("delivers the JSON payload on stdin, newline-terminated", async () => {
		const result = await runHookCommand("cat", '{"tool_name":"Bash"}', { cwd: dir });
		// The executor appends a trailing "\n" (see below); cat echoes it back.
		expect(result.stdout).toBe('{"tool_name":"Bash"}\n');
		expect(result.exitCode).toBe(0);
	});

	// Regression: a hook reading its payload with `read -r` must succeed. Without
	// a trailing newline, `read` hits EOF-before-delimiter, exits 1, and the
	// `if read -r line; then …` branch is skipped even though $line was set
	// (Claude Code bug CC-161). The hook here exits 7 only if the read succeeded.
	it("terminates stdin so `read -r` in a hook succeeds", async () => {
		const result = await runHookCommand('if read -r line; then exit 7; else exit 1; fi', '{"a":1}', {
			cwd: dir,
		});
		expect(result.exitCode).toBe(7);
	});

	it("does not double up a newline the payload already ends with", async () => {
		const result = await runHookCommand("cat", '{"x":1}\n', { cwd: dir });
		expect(result.stdout).toBe('{"x":1}\n');
	});

	it("survives a hook that exits without reading stdin", async () => {
		const big = JSON.stringify({ pad: "x".repeat(1_000_000) });
		const result = await runHookCommand("exit 2", big, { cwd: dir });
		expect(result.exitCode).toBe(2);
	});

	it("caps runaway output at 1MB", async () => {
		const result = await runHookCommand("yes x | head -c 3000000", "{}", { cwd: dir });
		expect(result.stdout.length).toBeLessThanOrEqual(1_000_000);
	});

	it("kills the whole process group on timeout, grandchildren included", async () => {
		const marker = join(dir, "grandchild-survived");
		// The backgrounded grandchild inherits the stdio pipes; without the
		// process-group SIGKILL, `close` waits for it and the marker appears.
		const command = `(sleep 3 && touch ${marker}) & sleep 3`;
		const started = Date.now();
		const result = await runHookCommand(command, "{}", { cwd: dir, timeoutSeconds: 1 });
		expect(result.timedOut).toBe(true);
		// Deterministic only because the executor normalizes it: `kill(-pgid)` is
		// NOT atomic across the group, so the shell can be scheduled after its
		// foreground `sleep` is killed and before its own SIGKILL lands, reap the
		// child and exit(128+9) itself — raw `close` then reports 137, which flaked
		// this assertion in roughly 3 of 312 runs under load (findings §10.20).
		expect(result.exitCode).toBeNull();
		expect(Date.now() - started).toBeLessThan(2500);
		await new Promise((r) => setTimeout(r, 2500));
		expect(existsSync(marker)).toBe(false);
	}, 10_000);

	it("exposes CLAUDE_PROJECT_DIR and runs in cwd", async () => {
		// Git Bash reports `pwd` in its own /tmp mount; `pwd -W` gives the Windows
		// path (forward-slashed), which is what `dir` is here.
		const pwd = process.platform === "win32" ? "$(pwd -W)" : "$(pwd)";
		const result = await runHookCommand(`echo "$CLAUDE_PROJECT_DIR|${pwd}"`, "{}", {
			cwd: dir,
			projectDir: "/some/project",
		});
		const same = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
		const [projectDir, cwd] = result.stdout.trim().split("|");
		expect(projectDir).toBe("/some/project");
		expect(same(cwd, dir), `${cwd} vs ${dir}`).toBe(true);
	});
});

describe("runHookCommand detached (fire-and-forget)", () => {
	// A `-p` run exits when the loop drains. `child.unref()` releases the process
	// handle only; inherited stdout/stderr pipes are ref'd handles of their own,
	// so a `sleep 20` SessionEnd hook held the run open for the full 20 s
	// (LIFECYCLE-REVIEW-2026-09-06 M4, measured). Run the executor in a child
	// node process and time its exit: it must not wait for the hook.
	it("does not keep the process alive for the hook's duration", async () => {
		const executor = join(process.cwd(), "extensions", "hooks", "executor.ts");
		const script = join(dir, "detached-probe.mts");
		writeFileSync(
			script,
			[
				// A file URL: on Windows a bare absolute path is not a valid ESM specifier.
				`import { runHookCommand } from ${JSON.stringify(pathToFileURL(executor).href)};`,
				`void runHookCommand("sleep 3", "{}", { cwd: process.cwd(), detached: true });`,
				`console.log("dispatched");`,
			].join("\n"),
		);
		const started = Date.now();
		const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], { cwd: process.cwd() });
			let out = "";
			let err = "";
			child.stdout.on("data", (chunk) => (out += chunk));
			child.stderr.on("data", (chunk) => (err += chunk));
			child.on("close", (exitCode) => resolve({ stdout: out, stderr: err, code: exitCode }));
		});
		expect(stdout.trim(), stderr).toBe("dispatched");
		expect(code).toBe(0);
		expect(Date.now() - started).toBeLessThan(2500);
	}, 10_000);
});
