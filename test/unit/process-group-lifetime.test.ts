import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { detachedSpawnOptions, rememberProcessGroup, waitForChildExit } from "../../extensions/lib/shell-run/process-tree.ts";
import { bashSpawnOrThrow, spawnShellCommand } from "../../extensions/lib/shell-run/shell-spawn.ts";
import { alive, until } from "./helpers/process-alive.ts";


describe.skipIf(process.platform === "win32")("remembered process groups", () => {
	it.each(["quit", "natural", "SIGINT", "SIGTERM", "SIGHUP"] as const)("a completed shell's child survives until its owner exits (%s)", async (how) => {
		const moduleUrl = pathToFileURL(resolve("extensions/lib/shell-run/bash-background.ts")).href;
		const script = [
			`import { runBackgroundBashBlocking } from ${JSON.stringify(moduleUrl)};`,
			`const keepAlive = setInterval(() => {}, 1000);`,
			`const result = await runBackgroundBashBlocking({ text: { earlierTruncated: '', spoolLost: () => '', emptyOutput: '' }, id: 'owner-test', command: 'sleep 60 & printf "%s %s\\n" "$$" "$!"', description: 'daemon', cwd: process.cwd() });`,
			`process.stdout.write(result.output);`,
			`process.stdin.once('data', () => { ${how === "natural" ? "clearInterval(keepAlive); process.stdin.destroy();" : "process.exit(0);"} });`,
		].join("\n");
		const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
		const exited = once(owner, "exit");
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`owner did not finish ${how}`)), 4_000);
		});
		let pid: number | undefined;
		let pgid: number | undefined;
		let error = "";
		owner.stderr.on("data", (chunk) => { error += chunk; });
		try {
			const [chunk] = await Promise.race([
				once(owner.stdout, "data"),
				exited.then(() => { throw new Error(`owner exited before ready: ${error}`); }),
				deadline,
			]);
			[pgid, pid] = String(chunk).trim().split(/\s+/).map(Number);
			expect(pid).toBeGreaterThan(0);
			expect(alive(pid)).toBe(true);
			if (how === "quit" || how === "natural") owner.stdin.end("quit\n");
			else owner.kill(how);
			await Promise.race([exited, deadline]);
			expect(await until(() => !alive(pid!))).toBe(true);
		} finally {
			clearTimeout(timer);
			if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
			if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
			if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
		}
	}, 10_000);

	it("forgets an empty group and removes its process-lifetime listeners", async () => {
		const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
		const before = events.map((event) => process.listenerCount(event));
		const child = spawnShellCommand(bashSpawnOrThrow(), "true", { ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"] });
		rememberProcessGroup(child);
		await waitForChildExit(child);
		expect(await until(() => events.every((event, index) => process.listenerCount(event) === before[index]))).toBe(true);
	});
});
