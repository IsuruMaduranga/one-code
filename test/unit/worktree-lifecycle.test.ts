import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../../extensions/lib/worktree-channel.ts";
import worktreeExtension from "../../extensions/worktree/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
type Result = { isError?: boolean; content: { text: string }[]; details: { worktreeState?: unknown } };
let root: string;
let repo: string;
let fake: FakePi;
let location: WorktreeLocation | null;
const ctx = () => createFakeCtx({ cwd: repo });
const enter = (params: Record<string, unknown>, context = ctx()) => fake.tools.get("enter_worktree")!.execute("enter", params, undefined, undefined, context) as Promise<Result>;
const exit = (params: Record<string, unknown>) => fake.tools.get("exit_worktree")!.execute("exit", params, undefined, undefined, ctx()) as Promise<Result>;
const start = async () => {
	const result = await enter({ name: "feature" });
	expect(result.isError).toBeUndefined();
	return join(repo, ".claude", "worktrees", "feature");
};

beforeEach(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "worktree-lifecycle-")));
	repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	// Windows runners default core.autocrlf to true, which rewrites checkouts with CRLF.
	git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "a.txt"), "original\n");
	writeFileSync(join(repo, ".gitignore"), "output.txt\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "initial");
	fake = createFakePi();
	location = null;
	fake.events.on(WORKTREE_CHANNEL, (data) => { location = data as WorktreeLocation | null; });
	worktreeExtension(fake.pi as never);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("worktree lifecycle safety", () => {
	it("leaves uncommitted work in the original checkout when creating a worktree", async () => {
		writeFileSync(join(repo, "a.txt"), "uncommitted\n");
		const path = await start();
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("uncommitted\n");
		expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("original\n");
	});

	it("rejects a non-git directory without changing the session", async () => {
		const result = await enter({ name: "feature" }, createFakeCtx({ cwd: root }));
		expect(result.isError).toBe(true);
		expect(location).toBeNull();
	});

	it("keeps the main checkout as the isolation root when launched inside another worktree", async () => {
		const linked = join(root, "linked");
		git(repo, "worktree", "add", "-qb", "linked", linked);
		writeFileSync(join(linked, "a.txt"), "linked branch\n");
		git(linked, "commit", "-qam", "linked change");
		const result = await enter({ name: "nested" }, createFakeCtx({ cwd: linked }));
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(location!.path, "a.txt"), "utf8")).toBe("linked branch\n");
		expect(location?.sharedRoot).toBe(repo);
	});

	it("does not execute repository checkout hooks when creating a worktree", async () => {
		const hooks = join(repo, ".git", "hooks");
		writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nprintf 'executed' > hook-ran.txt\n", { mode: 0o755 });
		const path = await start();
		expect(existsSync(join(path, "hook-ran.txt"))).toBe(false);
	});

	it("refuses creation when repository filters would execute outside the permission gate", async () => {
		writeFileSync(join(repo, ".gitattributes"), "a.txt filter=fixture\n");
		git(repo, "add", ".gitattributes");
		git(repo, "commit", "-qm", "filter attribute");
		git(repo, "config", "filter.fixture.smudge", "printf executed > filter-ran.txt; cat");
		const result = await enter({ name: "feature" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("filter");
		expect(existsSync(join(repo, ".claude", "worktrees", "feature", "filter-ran.txt"))).toBe(false);
	});

	it("does not replace an existing branch", async () => {
		git(repo, "branch", "feature");
		const head = git(repo, "rev-parse", "feature");
		expect((await enter({ name: "feature" })).isError).toBe(true);
		expect(git(repo, "rev-parse", "feature")).toBe(head);
		expect(location).toBeNull();
	});

	it("removes a worktree holding only ignored build output, as Claude Code does", async () => {
		const path = await start();
		writeFileSync(join(path, "output.txt"), "build output\n");
		const result = await exit({ action: "remove" });
		expect(result.isError).toBeUndefined();
		expect(existsSync(path)).toBe(false);
	});

	it("deletes the cleared branch even when the original checkout moved to a branch without its base", async () => {
		const path = await start();
		git(repo, "checkout", "-q", "--orphan", "elsewhere");
		git(repo, "commit", "-qm", "unrelated root", "--allow-empty");
		const result = await exit({ action: "remove" });
		expect(result.isError).toBeUndefined();
		expect(existsSync(path)).toBe(false);
		expect(git(repo, "branch", "--list", "feature")).toBe("");
	});

	it("refuses to remove hidden untracked files without discard consent", async () => {
		const path = await start();
		const file = "new.txt";
		git(repo, "config", "status.showUntrackedFiles", "no");
		writeFileSync(join(path, file), "user work\n");
		expect(git(path, "status", "--porcelain")).toBe("");
		const result = await exit({ action: "remove" });
		expect(result.isError).toBe(true);
		expect(existsSync(join(path, file))).toBe(true);
		expect(location?.path).toBe(path);
	});

	it("refuses to remove commits on detached HEAD", async () => {
		const path = await start();
		git(path, "checkout", "-q", "--detach");
		writeFileSync(join(path, "a.txt"), "committed work\n");
		git(path, "commit", "-qam", "detached work");
		const result = await exit({ action: "remove" });
		expect(result.isError).toBe(true);
		expect(existsSync(path)).toBe(true);
		expect(result.content[0].text).toContain("commit");
	});

	it("refuses to remove commits left on its branch after HEAD moves back", async () => {
		const path = await start();
		const base = git(path, "rev-parse", "HEAD");
		writeFileSync(join(path, "a.txt"), "committed work\n");
		git(path, "commit", "-qam", "branch work");
		git(path, "checkout", "-q", "--detach", base);
		expect((await exit({ action: "remove" })).isError).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	it("keeps changed files and commits when exiting with keep", async () => {
		const path = await start();
		writeFileSync(join(path, "a.txt"), "committed work\n");
		git(path, "commit", "-qam", "branch work");
		writeFileSync(join(path, "new.txt"), "uncommitted\n");
		const result = await exit({ action: "keep" });
		expect(result.isError).toBeUndefined();
		expect(existsSync(join(path, "new.txt"))).toBe(true);
		expect(location).toBeNull();
		const input = { command: "pwd" };
		await fake.fire("tool_call", { toolName: "bash", toolCallId: "after", input }, ctx());
		expect(input.command).toBe("pwd");
	});

	it("clears the active location when worktree removal succeeds but branch deletion fails", async () => {
		const path = await start();
		git(path, "branch", "-m", "renamed");
		const result = await exit({ action: "remove", discard_changes: true });
		expect(existsSync(path)).toBe(false);
		expect(location).toBeNull();
		expect(result.details.worktreeState).toBeNull();
		expect(result.content[0].text).toContain("branch");
	});

	it("rejects a listed worktree whose directory was removed outside the harness", async () => {
		const path = join(root, "other");
		git(repo, "worktree", "add", "-qb", "other", path);
		rmSync(path, { recursive: true });
		const result = await enter({ path });
		expect(result.isError).toBe(true);
		expect(location).toBeNull();
	});

	it("blocks tools instead of silently running in the main checkout when the active worktree disappears", async () => {
		const path = await start();
		rmSync(path, { recursive: true });
		for (const toolName of ["Agent", "workflow", "bash", "read"]) {
			const result = await fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", { toolName, toolCallId: toolName, input: { command: "pwd", path: "a.txt" } }, ctx());
			expect(result?.block, toolName).toBe(true);
			expect(result?.reason).toContain("no longer exists");
		}
		expect((await exit({ action: "keep" })).details.worktreeState).toBeNull();
	});

	it("accepts an existing worktree through a symlinked repository path", async () => {
		const path = await start();
		await exit({ action: "keep" });
		const alias = join(root, "alias");
		symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
		const result = await enter({ path: join(alias, ".claude", "worktrees", "feature") });
		expect(result.isError).toBeUndefined();
		expect(location?.path).toBe(path);
	});

	it("restores worktree rewriting from the persisted enter result on resume", async () => {
		const entered = await enter({ name: "feature" });
		const path = location!.path;
		const resumed = createFakePi();
		worktreeExtension(resumed.pi as never);
		await resumed.fire("session_start", { reason: "resume" }, createFakeCtx({ cwd: repo, sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "enter_worktree", toolCallId: "enter", details: entered.details } }] } }));
		const input = { path: "a.txt" };
		await resumed.fire("tool_call", { toolName: "read", toolCallId: "r", input }, ctx());
		expect(input.path).toBe(join(path, "a.txt"));
	});
});
