import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHookCommand } from "../../extensions/hooks/executor.ts";

// Real /bin/sh children, per the repo convention of never mocking
// child_process: keep spawn in a thin executor and test that executor live.
// realpath because macOS tmpdir lives behind a /var → /private/var symlink,
// and the child's pwd reports the resolved form.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-hooks-exec-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runHookCommand", () => {
	it("captures stdout, stderr, and the exit code", async () => {
		const result = await runHookCommand("echo out; echo err >&2; exit 3", "{}", { cwd: dir });
		expect(result.stdout.trim()).toBe("out");
		expect(result.stderr.trim()).toBe("err");
		expect(result.exitCode).toBe(3);
		expect(result.timedOut).toBe(false);
	});

	it("delivers the JSON payload on stdin", async () => {
		const result = await runHookCommand("cat", '{"tool_name":"Bash"}', { cwd: dir });
		expect(result.stdout).toBe('{"tool_name":"Bash"}');
		expect(result.exitCode).toBe(0);
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
		expect(result.exitCode).toBeNull();
		expect(Date.now() - started).toBeLessThan(2500);
		await new Promise((r) => setTimeout(r, 2500));
		expect(existsSync(marker)).toBe(false);
	}, 10_000);

	it("exposes CLAUDE_PROJECT_DIR and runs in cwd", async () => {
		const result = await runHookCommand('echo "$CLAUDE_PROJECT_DIR|$(pwd)"', "{}", {
			cwd: dir,
			projectDir: "/some/project",
		});
		expect(result.stdout.trim()).toBe(`/some/project|${dir}`);
	});
});
