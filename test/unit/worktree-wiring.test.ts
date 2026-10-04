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
import { REMINDER_CHANNEL, type ReminderPayload } from "../../extensions/lib/reminders.ts";
import { shellQuote } from "../../extensions/lib/shell-quote.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../../extensions/lib/worktree-channel.ts";
import worktreeExtension from "../../extensions/worktree/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

type GateResult = { block?: boolean; reason?: string } | undefined;

let repo: string;
let fake: FakePi;
let worktree: string;
const originals: OriginalCommandRecord[] = [];
const stateReminders: ReminderPayload[] = [];

beforeEach(async () => {
	// .native expands a Windows 8.3 short name (RUNNER~1) the way git reports the path.
	repo = realpathSync.native(mkdtempSync(join(tmpdir(), "worktree-wiring-")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", "a.txt");
	git("commit", "-qm", "init");

	fake = createFakePi();
	originals.length = 0;
	stateReminders.length = 0;
	fake.events.on(REMINDER_CHANNEL, (data) => stateReminders.push(data as ReminderPayload));
	fake.events.on(ORIGINAL_COMMAND_CHANNEL, (record) => originals.push(record as OriginalCommandRecord));
	let location: WorktreeLocation | null = null;
	fake.events.on(WORKTREE_CHANNEL, (data) => {
		location = data as WorktreeLocation | null;
	});
	worktreeExtension(fake.pi as never);
	const ctx = createFakeCtx({ cwd: repo, sessionManager: { getBranch: () => [] } });
	await fake.fire("session_start", {}, ctx);
	const entered = (await fake.tools.get("enter_worktree")!.execute("e1", { name: "feature" }, undefined, undefined, ctx)) as { isError?: boolean; content: { text: string }[] };
	expect(entered.isError).toBeUndefined();
	// The git-isolation guard is announced on entry, not first met as a refusal.
	expect(entered.content[0]?.text).toContain("Git commands aimed at the main checkout or another worktree of this repository are refused until you exit.");
	worktree = join(repo, ".claude", "worktrees", "feature");
	expect(location).toEqual({ path: worktree, branch: "feature", sharedRoot: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const toolCall = async (toolName: string, input: Record<string, unknown>, toolCallId = "t1") =>
	(await fake.fireOne<GateResult>("tool_call", { toolName, toolCallId, input })) ?? undefined;

describe("worktree state announcements", () => {
	it("binds created and existing-worktree activation to the entering tool result", async () => {
		expect(stateReminders.find((entry) => entry.text?.startsWith("Worktree session active"))).toMatchObject({ toolCallId: "e1" });
		stateReminders.length = 0;
		await fake.tools.get("enter_worktree")!.execute("e2", { path: worktree }, undefined, undefined, createFakeCtx({ cwd: repo }));
		expect(stateReminders.find((entry) => entry.text?.startsWith("Worktree session active"))).toMatchObject({ toolCallId: "e2" });
	});

	it("announces a restored worktree that disappeared instead of silently clearing its sticky state", async () => {
		const resumed = createFakePi();
		const reminders: ReminderPayload[] = [];
		resumed.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as ReminderPayload));
		worktreeExtension(resumed.pi as never);
		const missingPath = join(repo, "missing-worktree");
		const ctx = createFakeCtx({
			cwd: repo,
			sessionManager: { getBranch: () => [{ type: "message", message: {
				role: "toolResult", toolName: "enter_worktree", toolCallId: "old", content: [], timestamp: 1,
				details: { worktreeState: { path: missingPath, originalCwd: repo, sharedRoot: repo, createdByUs: false } },
			} }] },
		});
		await resumed.fire("session_start", {}, ctx);
		expect(reminders).toContainEqual({ key: "cc-worktree-session", remove: true });
		const notice = reminders.find((entry) => entry.text && entry.scope !== "every-turn");
		expect(notice?.text).toContain(`back in ${repo}`);
		expect(notice?.text).toContain(missingPath);
		expect(notice?.text).toContain("no longer exists");
	});

	it.each(["keep", "remove"])("exit_worktree %s reports the switch in its result", async (action) => {
		const result = await fake.tools.get("exit_worktree")!.execute("exit", { action }, undefined, undefined, createFakeCtx({ cwd: repo })) as {
			content: { text: string }[]; details: { worktreeState: unknown }; isError?: boolean;
		};
		expect(result.isError).toBeUndefined();
		expect(result.details.worktreeState).toBeNull();
		expect(result.content[0].text).toContain(`back in ${repo}`);
	});
});

describe("monitor in a worktree session", () => {
	it("runs its command in the worktree and publishes the original", async () => {
		const input = { command: "until [ -f dist/index.js ]; do sleep 2; done", description: "build output" };
		expect(await toolCall("monitor", input, "m1")).toBeUndefined();
		expect(input.command).toBe(`cd '${worktree}' && (until [ -f dist/index.js ]; do sleep 2; done\n)`);
		expect(originals).toEqual([{ toolCallId: "m1", command: "until [ -f dist/index.js ]; do sleep 2; done", cwd: worktree }]);
	});

	it("refuses git aimed at the shared checkout, like bash", async () => {
		// Quoted: bash reads a Windows path's backslashes as escapes otherwise.
		const result = await toolCall("monitor", { command: `git -C ${shellQuote(repo)} log -1`, description: "watch" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain(`isolated in the worktree ${worktree}`);
	});

	it("refuses git aimed at a linked worktree outside the shared checkout", async () => {
		const outside = join(realpathSync.native(mkdtempSync(join(tmpdir(), "worktree-outside-"))), "wt2");
		execFileSync("git", ["worktree", "add", "-q", "-b", "outside", outside], { cwd: repo });
		try {
			const result = await toolCall("bash", { command: `git -C ${shellQuote(outside)} status` });
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("another worktree of the same repository");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("leaves a WebSocket monitor alone", async () => {
		const input = { ws: { url: "wss://example.test" }, description: "socket" };
		expect(await toolCall("monitor", input)).toBeUndefined();
		expect(input).toEqual({ ws: { url: "wss://example.test" }, description: "socket" });
	});
});

describe("powershell in a worktree session", () => {
	it("refuses git aimed at the shared checkout before rewriting the command", async () => {
		const input = { command: `Set-Location ${repo}; git reset --hard` };
		const result = await toolCall("powershell", input);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("shared checkout");
		expect(input.command).toBe(`Set-Location ${repo}; git reset --hard`);
	});

	it("lets worktree git through with the Set-Location prefix", async () => {
		const input = { command: "git status" };
		expect(await toolCall("powershell", input)).toBeUndefined();
		expect(input.command).toBe(`Set-Location -LiteralPath '${worktree}' -ErrorAction Stop; git status`);
	});
});
