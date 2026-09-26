/**
 * worktree/index.ts wiring: after enter_worktree, the tool_call hook guards
 * and rewrites every tool that runs a command. The repository lives in a temp
 * directory, never in a real checkout.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGINAL_COMMAND_CHANNEL, type OriginalCommandRecord } from "../../extensions/lib/original-command.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../../extensions/lib/worktree-channel.ts";
import worktreeExtension from "../../extensions/worktree/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

type GateResult = { block?: boolean; reason?: string } | undefined;

let repo: string;
let fake: FakePi;
let worktree: string;
const originals: OriginalCommandRecord[] = [];

beforeEach(async () => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "worktree-wiring-")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", "a.txt");
	git("commit", "-qm", "init");

	fake = createFakePi();
	originals.length = 0;
	fake.events.on(ORIGINAL_COMMAND_CHANNEL, (record) => originals.push(record as OriginalCommandRecord));
	let location: WorktreeLocation | null = null;
	fake.events.on(WORKTREE_CHANNEL, (data) => {
		location = data as WorktreeLocation | null;
	});
	worktreeExtension(fake.pi as never);
	const ctx = createFakeCtx({ cwd: repo, sessionManager: { getBranch: () => [] } });
	await fake.fire("session_start", {}, ctx);
	const entered = (await fake.tools.get("enter_worktree")!.execute("e1", { name: "feature" }, undefined, undefined, ctx)) as { isError?: boolean };
	expect(entered.isError).toBeUndefined();
	worktree = join(repo, ".claude", "worktrees", "feature");
	expect(location).toEqual({ path: worktree, branch: "feature", sharedRoot: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const toolCall = async (toolName: string, input: Record<string, unknown>, toolCallId = "t1") =>
	(await fake.fireOne<GateResult>("tool_call", { toolName, toolCallId, input })) ?? undefined;

describe("monitor in a worktree session", () => {
	it("runs its command in the worktree and publishes the original", async () => {
		const input = { command: "until [ -f dist/index.js ]; do sleep 2; done", description: "build output" };
		expect(await toolCall("monitor", input, "m1")).toBeUndefined();
		expect(input.command).toBe(`cd '${worktree}' && (until [ -f dist/index.js ]; do sleep 2; done\n)`);
		expect(originals).toEqual([{ toolCallId: "m1", command: "until [ -f dist/index.js ]; do sleep 2; done", cwd: worktree }]);
	});

	it("refuses git aimed at the shared checkout, like bash", async () => {
		const result = await toolCall("monitor", { command: `git -C ${repo} log -1`, description: "watch" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(`isolated in the worktree ${worktree}`);
	});

	it("leaves a WebSocket monitor alone", async () => {
		const input = { ws: { url: "wss://example.test" }, description: "socket" };
		expect(await toolCall("monitor", input)).toBeUndefined();
		expect(input).toEqual({ ws: { url: "wss://example.test" }, description: "socket" });
	});
});
