/**
 * git reads a directory holding `HEAD`, `objects` and `refs` as a repository
 * and runs what its `config` names, so a git read there is not provably safe
 * (2026-11-22 shell-analysis review, F3 and F4).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutGitRunsProgram, checkoutRunsOwnProgram, configRunsProgram } from "../../extensions/lib/shell/git-checkout-programs.ts";
import { analyzeShellCommand } from "../../extensions/lib/shell/shell-analysis.ts";

let cwd: string;
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "bare-repo-")));
	execFileSync("git", ["init", "-q"], { cwd });
	const inner = join(cwd, "vendor", "x");
	mkdirSync(join(inner, "objects"), { recursive: true });
	mkdirSync(join(inner, "refs"));
	writeFileSync(join(inner, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(inner, "config"), "[core]\n\tbare = false\n\tworktree = ../..\n\tfsmonitor = touch pwned\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("a repository layout in a subdirectory", () => {
	it("counts as a program for a git command run there, and not for one run in the checkout", () => {
		expect(checkoutGitRunsProgram(join(cwd, "vendor", "x"), "/home/dana")).toEqual({ kind: "bareRepository", dir: join(cwd, "vendor", "x") });
		expect(checkoutGitRunsProgram(join(cwd, "vendor"), "/home/dana")).toBeUndefined();
		expect(checkoutGitRunsProgram(cwd, "/home/dana")).toBeUndefined();
	});

	it("takes the safe verdict from git -C into it", () => {
		const verdict = (command: string) => analyzeShellCommand({ command, cwd, home: "/home/dana" }).verdict;
		expect(verdict("git status")).toBe("safe");
		expect(verdict("git -C vendor/x status")).not.toBe("safe");
	});
});

describe("config keys a read runs", () => {
	it("counts a remote's uploadpack as a program", () => {
		expect(configRunsProgram('[remote "origin"]\n\tuploadpack = ./tool.sh\n').program).toBe("remote.uploadpack");
	});

	// A partial clone runs nothing the checkout names, but a read of a missing object
	// reaches the network: its own kind, which a read escalates on and a worktree does not refuse.
	it.each([
		['[remote "origin"]\n\tpromisor = true\n', "remote.promisor"],
		["[extensions]\n\tpartialClone = origin\n", "extensions.partialclone"],
		['[core]\n\tsshCommand = ./tool.sh\n[remote "origin"]\n\tpromisor = true\n', "core.sshcommand"],
	])("reports a promisor remote apart from a program: %s", (text, key) => {
		expect(configRunsProgram(text)).toEqual({ hooksPaths: [], promisor: key });
	});

	it("ignores core.sshCommand without a promisor remote", () => {
		expect(configRunsProgram("[core]\n\tsshCommand = ssh -i key\n")).toEqual({ hooksPaths: [] });
	});

	it("escalates a read in a partial clone and names no program for a worktree", () => {
		execFileSync("git", ["config", "remote.origin.promisor", "true"], { cwd });
		expect(checkoutGitRunsProgram(cwd, "/home/dana")).toEqual({ kind: "promisorRemote", key: "remote.promisor" });
		expect(analyzeShellCommand({ command: "git status", cwd, home: "/home/dana" }).verdict).not.toBe("safe");
		expect(checkoutRunsOwnProgram(cwd, "/home/dana")).toBeUndefined();
		execFileSync("git", ["config", "core.fsmonitor", "touch pwned"], { cwd });
		expect(checkoutRunsOwnProgram(cwd, "/home/dana")).toEqual({ kind: "configSetsProgram", key: "core.fsmonitor" });
	});

	it("no longer lists --remerge-diff as a read", () => {
		expect(analyzeShellCommand({ command: "git show --remerge-diff HEAD", cwd, home: "/home/dana" }).verdict).not.toBe("safe");
	});
});
