import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupWorktree, createWorktree, keptWorktreeNote, type Worktree } from "../../extensions/subagents/worktree.ts";
import { releaseWorktreeIsolation, worktreeIsolationFor } from "../../extensions/lib/worktree-isolation.ts";

// Every repository here lives in a temp directory, never in a real checkout.
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

let repo: string;
let worktree: Worktree | undefined;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "subagent-wt-repo-"));
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-qm", "init");
});

afterEach(() => {
	vi.restoreAllMocks();
	if (worktree) {
		releaseWorktreeIsolation(worktree.path);
		rmSync(join(worktree.path, ".."), { recursive: true, force: true });
	}
	worktree = undefined;
	rmSync(repo, { recursive: true, force: true });
});

const branches = () => git(repo, "branch", "--list", "cc-subagent/*");

describe("isolation worktree cleanup", () => {
	it("records the commit it was created at", async () => {
		worktree = await createWorktree(repo, "agent");
		expect(worktree.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
	});

	it("removes an untouched worktree and its branch", async () => {
		worktree = await createWorktree(repo, "agent");
		expect(await cleanupWorktree(repo, worktree)).toBe(true);
		expect(existsSync(worktree.path)).toBe(false);
		expect(branches()).toBe("");
	});

	it("keeps a worktree whose agent committed its work, with the branch holding the commit", async () => {
		worktree = await createWorktree(repo, "agent");
		writeFileSync(join(worktree.path, "b.txt"), "b\n");
		git(worktree.path, "add", "b.txt");
		git(worktree.path, "commit", "-qm", "agent work");
		const commit = git(worktree.path, "rev-parse", "HEAD");

		expect(await cleanupWorktree(repo, worktree)).toBe(false);
		expect(existsSync(worktree.path)).toBe(true);
		expect(git(repo, "branch", "--contains", commit)).toContain(worktree.branch);
	});

	it("keeps a worktree whose commit sits on its branch after HEAD moved away", async () => {
		worktree = await createWorktree(repo, "agent");
		writeFileSync(join(worktree.path, "b.txt"), "b\n");
		git(worktree.path, "add", "b.txt");
		git(worktree.path, "commit", "-qm", "agent work");
		git(worktree.path, "checkout", "-q", "--detach", worktree.baseCommit);

		expect(await cleanupWorktree(repo, worktree)).toBe(false);
		expect(existsSync(worktree.path)).toBe(true);
	});

	it("keeps a worktree with uncommitted edits", async () => {
		worktree = await createWorktree(repo, "agent");
		writeFileSync(join(worktree.path, "a.txt"), "edited\n");
		expect(await cleanupWorktree(repo, worktree)).toBe(false);
		expect(existsSync(worktree.path)).toBe(true);
	});

	it("keeps untracked work even when repository status settings hide it", async () => {
		git(repo, "config", "status.showUntrackedFiles", "no");
		worktree = await createWorktree(repo, "agent");
		writeFileSync(join(worktree.path, "new.txt"), "agent work\n");
		expect(git(worktree.path, "status", "--porcelain")).toBe("");

		expect(await cleanupWorktree(repo, worktree)).toBe(false);
		expect(existsSync(join(worktree.path, "new.txt"))).toBe(true);
	});

	it("removes a worktree holding only ignored files, as Claude Code does (build output must not pile up)", async () => {
		writeFileSync(join(repo, ".gitignore"), "output.txt\n");
		git(repo, "add", ".gitignore");
		git(repo, "commit", "-qm", "ignore output");
		worktree = await createWorktree(repo, "agent");
		writeFileSync(join(worktree.path, "output.txt"), "agent output\n");
		expect(git(worktree.path, "status", "--porcelain")).toBe("");

		expect(await cleanupWorktree(repo, worktree)).toBe(true);
		expect(existsSync(worktree.path)).toBe(false);
	});

	it.each(["default", "configured"])("does not execute %s repository hooks while creating isolation", async (source) => {
		const hooks = source === "default" ? join(repo, ".git", "hooks") : join(repo, "custom-hooks");
		mkdirSync(hooks, { recursive: true });
		writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nprintf 'executed' > hook-ran.txt\n", { mode: 0o755 });
		if (source === "configured") git(repo, "config", "core.hooksPath", hooks);

		worktree = await createWorktree(repo, "agent");
		expect(existsSync(join(worktree.path, "hook-ran.txt"))).toBe(false);
	});

	it("creates distinct branches for same-label agents started in the same millisecond", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
		worktree = await createWorktree(repo, "agent");
		const second = await createWorktree(repo, "agent");
		try {
			expect(second.branch).not.toBe(worktree.branch);
			expect(await cleanupWorktree(repo, second)).toBe(true);
		} finally {
			releaseWorktreeIsolation(second.path);
			rmSync(join(second.path, ".."), { recursive: true, force: true });
		}
	});

	it("branches from an entered worktree's HEAD and guards the main checkout as shared", async () => {
		const entered = join(repo, ".claude", "worktrees", "feature");
		git(repo, "worktree", "add", "-q", "-b", "feature", entered, "HEAD");
		writeFileSync(join(entered, "c.txt"), "c\n");
		git(entered, "add", "c.txt");
		git(entered, "commit", "-qm", "session work");

		worktree = await createWorktree(entered, "agent");
		expect(worktree.baseCommit).toBe(git(entered, "rev-parse", "HEAD"));
		expect(existsSync(join(worktree.path, "c.txt"))).toBe(true);
		expect(worktreeIsolationFor(worktree.path)?.sharedRoot).toBe(realpathSync.native(repo));
		expect(await cleanupWorktree(entered, worktree)).toBe(true);
		expect(branches()).toBe("");
	});

	it("names the branch in the kept-worktree note", () => {
		expect(keptWorktreeNote("/tmp/wt", "cc-subagent/x")).toContain("/tmp/wt on branch cc-subagent/x");
	});
});
