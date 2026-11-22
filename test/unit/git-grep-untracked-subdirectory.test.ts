/**
 * From a subdirectory of a larger repository, `git grep --untracked` with a
 * top-level pathspec prints untracked and ignored files above the working
 * directory, so it is not provably an in-project read (2026-11-22
 * shell-analysis review, F8).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeShellCommand } from "../../extensions/lib/shell/shell-analysis.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "grep-untracked-")));
execFileSync("git", ["init", "-q"], { cwd: root });
const pkg = join(root, "packages", "app");
mkdirSync(join(pkg, "src"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const verdict = (command: string, cwd = pkg) => analyzeShellCommand({ command, cwd, home: "/home/dana" }).verdict;

describe("git grep --untracked", () => {
	it("escalates in a subdirectory of the repository, whatever pathspec it names", () => {
		expect(verdict("git grep --untracked --no-exclude-standard -h -e TOKEN -- ':/'")).toBe("escalate");
		expect(verdict("git grep --untracked -e TOKEN -- ../..")).toBe("escalate");
		expect(verdict("git grep --untracked -e TOKEN")).toBe("escalate");
		expect(verdict("git -C src grep --untracked -e TOKEN")).toBe("escalate");
	});

	it("stays safe at the repository root and through -C into the working directory's own repository", () => {
		expect(verdict("git grep --untracked -e TOKEN", root)).toBe("safe");
		expect(verdict("git -C packages grep --untracked -e TOKEN", root)).toBe("safe");
	});

	it("leaves a tracked-only grep alone: committed files above the subdirectory are what git log -p prints too", () => {
		expect(verdict("git grep -e TOKEN -- ':/'")).toBe("safe");
		expect(verdict("git grep -e TOKEN")).toBe("safe");
	});
});
