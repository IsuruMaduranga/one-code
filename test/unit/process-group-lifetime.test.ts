import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { spawnOwnedShell } from "../../extensions/lib/shell-run/bash-background.ts";
import { waitForChildExit } from "../../extensions/lib/shell-run/process-tree.ts";
import { bashSpawnOrThrow } from "../../extensions/lib/shell-run/shell-spawn.ts";
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

	const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
	const listenerCounts = () => events.map((event) => process.listenerCount(event));
	const ownedShell = (command: string) => spawnOwnedShell({ shell: bashSpawnOrThrow(), command, cwd: process.cwd() });

	it("forgets an empty group and removes its process-lifetime listeners when its leader exits", async () => {
		const before = listenerCounts();
		const tree = ownedShell("true");
		expect(listenerCounts()).not.toEqual(before);
		await waitForChildExit(tree.child);
		expect(listenerCounts()).toEqual(before);
	});

	it("polls a group only while it outlives its leader", async () => {
		const before = listenerCounts();
		const intervals = vi.spyOn(globalThis, "setInterval");
		const clears = vi.spyOn(globalThis, "clearInterval");
		const reapers = () => intervals.mock.results.filter((_, index) => (intervals.mock.calls[index][0] as { name?: string }).name === "reapGroups").map((result) => result.value);
		let member: number | undefined;
		const running = ownedShell("sleep 30");
		try {
			// A group with a live leader is probed when the leader exits, never polled.
			await new Promise((resolveWait) => setTimeout(resolveWait, 200));
			expect(reapers()).toEqual([]);

			// The leader exits and leaves a member running: poll until the member is gone.
			const orphaned = ownedShell("sleep 1 </dev/null >/dev/null 2>&1 & echo $!");
			const [chunk] = await once(orphaned.child.stdout!, "data");
			member = Number(String(chunk).trim());
			await waitForChildExit(orphaned.child);
			expect(alive(member)).toBe(true);
			expect(reapers()).toHaveLength(1);
			expect(await until(() => clears.mock.calls.some(([timer]) => timer === reapers()[0]), 100)).toBe(true);
			expect(alive(member)).toBe(false);
		} finally {
			intervals.mockRestore();
			clears.mockRestore();
			running.kill("SIGKILL");
			if (member) { try { process.kill(member, "SIGKILL"); } catch {} }
		}
		await waitForChildExit(running.child);
		expect(listenerCounts()).toEqual(before);
	}, 10_000);
});
