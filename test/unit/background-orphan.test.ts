import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import backgroundExtension from "../../extensions/background/index.ts";
import bashExtension from "../../extensions/bash/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const isAlive = (pid: number) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

// A task may intentionally launch a daemon inside its process group. Once its
// leader has completed, that group belongs to the process, not the session.
describe.skipIf(process.platform === "win32")("background process groups after the leader exits", () => {
	it.each(["bash", "monitor"])("%s preserves a completed task's child through session replacement", async (name) => {
		const dir = mkdtempSync(join(tmpdir(), "background-orphan-"));
		let pid: number | undefined;
		const fake = createFakePi();
		backgroundExtension(fake.pi as never);
		bashExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: dir, mode: "rpc", sessionManager: { getSessionDir: () => dir } });
		try {
			const pidfile = join(dir, "child.pid");
			const command = `sleep 60 & echo $! > '${pidfile}'; printf 'leader finished\\n'`;
			const start = await fake.tools.get(name)!.execute("start", { command, description: "daemon", run_in_background: true }, undefined, undefined, ctx) as { details: { taskId: string } };
			const result = await fake.tools.get("task_output")!.execute("output", { task_id: start.details.taskId, timeout: 5000 }, undefined, undefined, ctx) as { details: { status: string } };
			expect(result.details.status).toBe("completed");
			pid = Number(readFileSync(pidfile, "utf8").trim());
			expect(isAlive(pid)).toBe(true);
			await fake.fire("session_shutdown", { reason: "new" }, ctx);
			// A fresh extension instance models /clear's replacement. Nothing in
			// either session may dispose the remembered group of a completed task.
			const next = createFakePi();
			backgroundExtension(next.pi as never);
			bashExtension(next.pi as never);
			await next.fire("session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(isAlive(pid)).toBe(true);
			await next.fire("session_shutdown", { reason: "quit" }, ctx);
		} finally {
			await fake.fire("session_shutdown", { reason: "quit" }, ctx);
			if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
			rmSync(dir, { recursive: true, force: true });
		}
	}, 10_000);
});
