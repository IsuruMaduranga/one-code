import { execFileSync } from "node:child_process";

/**
 * The repository settings a test needs so its commits and tags never depend on
 * the developer's own git configuration: a fixed identity, and no signing even
 * when the global configuration turns `commit.gpgsign` or `tag.gpgsign` on.
 * Linked worktrees of the repository read the same file.
 */
const TEST_REPO_CONFIG: ReadonlyArray<readonly [string, string]> = [
	["user.name", "test"],
	["user.email", "test@example.invalid"],
	["commit.gpgsign", "false"],
	["tag.gpgsign", "false"],
];

/** `git init` in `cwd` (created by the caller), then the test settings above. */
export function initTestRepo(cwd: string): void {
	execFileSync("git", ["init", "-q"], { cwd });
	for (const [key, value] of TEST_REPO_CONFIG) execFileSync("git", ["config", key, value], { cwd });
}
