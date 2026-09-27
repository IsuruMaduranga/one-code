/**
 * A workflow agent() with `isolation: 'worktree'` never leaks its worktree
 * when setup fails, and a failed agent that committed keeps its worktree and
 * reports it on the error. Repositories live in temp directories only.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentLoader from "../../extensions/lib/agent-loader.ts";
import { AgentRunner } from "../../extensions/workflow/agent-session.ts";
import { keptWorktreeOf } from "../../extensions/workflow/types.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

let repo: string;
let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "wf-wt-agent-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	repo = mkdtempSync(join(tmpdir(), "wf-wt-repo-"));
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-qm", "init");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const line of git(repo, "worktree", "list", "--porcelain").split("\n")) {
		const path = line.startsWith("worktree ") ? line.slice("worktree ".length) : undefined;
		// Everything but the main checkout (git prints `C:/…` on Windows, so compare base names):
		// removing the main checkout's parent would remove the whole temp directory.
		if (path && basename(path) !== basename(repo)) rmSync(join(path, ".."), { recursive: true, force: true });
	}
	rmSync(repo, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

const worktreeCount = () => git(repo, "worktree", "list").split("\n").length;
const branches = () => git(repo, "branch", "--list", "cc-subagent/*");

describe("workflow agent worktrees", () => {
	it("create no worktree when the schema is not an object schema", async () => {
		const runner = await AgentRunner.create({ cwd: repo, defaultModel: undefined });
		await expect(
			runner.run("do it", { isolation: "worktree", schema: { type: "array", items: { type: "string" } } }, new AbortController().signal),
		).rejects.toThrow(/top-level type "object"/);
		expect(worktreeCount()).toBe(1);
		expect(branches()).toBe("");
	});

	it("remove the worktree when the session fails to open", async () => {
		vi.spyOn(agentLoader, "openChildSession").mockRejectedValue(new Error("loader broke"));
		const runner = await AgentRunner.create({ cwd: repo, defaultModel: undefined });
		await expect(runner.run("do it", { isolation: "worktree" }, new AbortController().signal)).rejects.toThrow("loader broke");
		expect(worktreeCount()).toBe(1);
		expect(branches()).toBe("");
	});

	it("keep and report the worktree of a failed agent that committed", async () => {
		const notices: string[] = [];
		vi.spyOn(agentLoader, "openChildSession").mockImplementation(async (options) => {
			const cwd = (options as { session: { cwd: string } }).session.cwd;
			writeFileSync(join(cwd, "b.txt"), "b\n");
			git(cwd, "add", "b.txt");
			git(cwd, "commit", "-qm", "agent work");
			throw new Error("session died after committing");
		});
		const runner = await AgentRunner.create({ cwd: repo, defaultModel: undefined, onNotice: (message) => notices.push(message) });
		const error = await runner.run("do it", { isolation: "worktree", label: "migrate" }, new AbortController().signal).catch((e: unknown) => e);
		const kept = keptWorktreeOf(error);
		expect(kept?.path).toBeDefined();
		expect(kept?.branch).toMatch(/^cc-subagent\/migrate-/);
		expect(worktreeCount()).toBe(2);
		expect(branches()).toContain(kept!.branch!);
		expect(notices.some((notice) => notice.includes(`worktree kept at ${kept!.path}`))).toBe(true);
	});
});
