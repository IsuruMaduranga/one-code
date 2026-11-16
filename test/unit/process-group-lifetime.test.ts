import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { spawnOwnedShell } from "../../extensions/lib/shell-run/bash-background.ts";
import { waitForChildExit } from "../../extensions/lib/shell-run/process-tree.ts";
import { bashSpawnOrThrow } from "../../extensions/lib/shell-run/shell-spawn.ts";
import { alive, startShellOwner, until } from "./helpers/process-alive.ts";

describe.skipIf(process.platform === "win32")("remembered process groups", () => {
	it.each(["quit", "natural", "SIGINT", "SIGTERM", "SIGHUP"] as const)("a completed shell's child survives until its owner exits (%s)", async (how) => {
		const run = await startShellOwner('sleep 60 & printf "%s %s\\n" "$$" "$!"', how === "natural" ? "clearInterval(keepAlive); process.stdin.destroy();" : "process.exit(0);");
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`owner did not finish ${how}`)), 4_000);
		});
		try {
			expect(run.worker).toBeGreaterThan(0);
			expect(alive(run.worker)).toBe(true);
			if (how === "quit" || how === "natural") run.owner.stdin.end("quit\n");
			else run.owner.kill(how);
			await Promise.race([run.exited, deadline]);
			expect(await until(() => !alive(run.worker))).toBe(true);
		} finally {
			clearTimeout(timer);
			run.cleanup();
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
