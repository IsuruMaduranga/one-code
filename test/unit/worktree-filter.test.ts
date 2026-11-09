import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createWorktree, type Worktree } from "../../extensions/lib/agents/agent-worktree.ts";
import { releaseWorktreeIsolation } from "../../extensions/lib/worktree-isolation.ts";
import { envName } from "../../extensions/lib/brand.mjs";
import { requireText } from "../../extensions/lib/profile.ts";

it("refuses isolation before a repository checkout filter can execute", async () => {
	const repo = mkdtempSync(join(tmpdir(), "worktree-filter-"));
	const marker = join(repo, "filter-ran.txt");
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
	let worktree: Worktree | undefined;
	vi.stubEnv(envName("WORKTREE_FILTER_MARKER"), marker);
	try {
		git("init", "-q");
		writeFileSync(join(repo, "a.txt"), "text\n");
		writeFileSync(join(repo, ".gitattributes"), "a.txt filter=fixture\n");
		git("add", ".");
		git("commit", "-qm", "fixture");
		git("config", "filter.fixture.smudge", `printf executed > "$${envName("WORKTREE_FILTER_MARKER")}"; cat`);

		await expect(createWorktree(repo, "filter-probe").then((created) => {
			worktree = created;
			return created;
		})).rejects.toThrow(requireText("subagents").worktreeRefused({ program: { kind: "configSetsProgram", key: "filter.smudge" } }));
		expect(existsSync(marker)).toBe(false);
		expect(git("branch", "--list", "cc-subagent/*")).toBe("");
		expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	} finally {
		vi.unstubAllEnvs();
		if (worktree) {
			releaseWorktreeIsolation(worktree.path);
			rmSync(join(worktree.path, ".."), { recursive: true, force: true });
		}
		rmSync(repo, { recursive: true, force: true });
	}
});
