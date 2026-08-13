import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkRecoverability,
	combine,
	judgeTargets,
	judgeWholeTree,
	type RecoverabilityResult,
	type TargetState,
} from "../../extensions/auto-mode/recoverability.ts";

describe("judgeTargets (pure)", () => {
	const t = (over: Partial<TargetState>): TargetState => ({ token: "f", tracked: true, dirty: false, ...over });

	it("clears when every target is tracked and clean", () => {
		expect(judgeTargets([t({}), t({ token: "g" })]).verdict).toBe("recoverable");
	});

	it("refuses an untracked target — git cannot restore it", () => {
		expect(judgeTargets([t({}), t({ token: "new.txt", tracked: false })]).verdict).toBe("unrecoverable");
	});

	it("refuses a tracked-but-dirty target — the uncommitted change would be lost", () => {
		expect(judgeTargets([t({ token: "edited.txt", dirty: true })]).verdict).toBe("unrecoverable");
	});

	it("is unknown when no target could be identified", () => {
		expect(judgeTargets([]).verdict).toBe("unknown");
	});

	it("names the offending target, not file contents", () => {
		expect(judgeTargets([t({ token: "secret.txt", tracked: false })]).reason).toContain("secret.txt");
	});
});

describe("judgeWholeTree (pure)", () => {
	it("clears a clean tree", () => {
		expect(judgeWholeTree(true, "").verdict).toBe("recoverable");
		expect(judgeWholeTree(true, "  \n ").verdict).toBe("recoverable");
	});

	it("refuses a dirty tree", () => {
		expect(judgeWholeTree(true, " M tracked.txt\n").verdict).toBe("unrecoverable");
		expect(judgeWholeTree(true, "?? untracked.txt\n").verdict).toBe("unrecoverable");
	});

	it("refuses when it is not a git repo", () => {
		expect(judgeWholeTree(false, "").verdict).toBe("unrecoverable");
	});
});

describe("combine", () => {
	const r = (verdict: RecoverabilityResult["verdict"]): RecoverabilityResult => ({ verdict, reason: verdict });
	it("takes unrecoverable over everything", () => {
		expect(combine([r("recoverable"), r("unrecoverable"), r("unknown")]).verdict).toBe("unrecoverable");
	});
	it("takes unknown over recoverable", () => {
		expect(combine([r("recoverable"), r("unknown")]).verdict).toBe("unknown");
	});
	it("clears only when all parts are recoverable", () => {
		expect(combine([r("recoverable"), r("recoverable")]).verdict).toBe("recoverable");
	});
});

describe("checkRecoverability (real git)", () => {
	let repo: string;
	const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "cc-recover-"));
		g("init", "-q");
		g("config", "user.email", "a@b.c");
		g("config", "user.name", "a");
		writeFileSync(join(repo, "committed.txt"), "v1\n");
		g("add", "committed.txt");
		g("commit", "-qm", "init");
	});

	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("clears deleting a tracked, clean file", () => {
		expect(checkRecoverability(repo, { targets: [join(repo, "committed.txt")], wholeTree: false }).verdict).toBe(
			"recoverable",
		);
	});

	it("refuses deleting an untracked file", () => {
		writeFileSync(join(repo, "untracked.txt"), "x\n");
		expect(checkRecoverability(repo, { targets: [join(repo, "untracked.txt")], wholeTree: false }).verdict).toBe(
			"unrecoverable",
		);
	});

	it("refuses deleting a tracked file with uncommitted edits", () => {
		writeFileSync(join(repo, "committed.txt"), "v2 uncommitted\n");
		expect(checkRecoverability(repo, { targets: [join(repo, "committed.txt")], wholeTree: false }).verdict).toBe(
			"unrecoverable",
		);
	});

	it("clears a whole-tree reset on a clean tree", () => {
		expect(checkRecoverability(repo, { targets: [], wholeTree: true }).verdict).toBe("recoverable");
	});

	it("refuses a whole-tree reset on a dirty tree", () => {
		writeFileSync(join(repo, "committed.txt"), "dirty\n");
		expect(checkRecoverability(repo, { targets: [], wholeTree: true }).verdict).toBe("unrecoverable");
	});

	it("refuses a whole-tree reset when untracked files are present", () => {
		writeFileSync(join(repo, "untracked.txt"), "x\n");
		expect(checkRecoverability(repo, { targets: [], wholeTree: true }).verdict).toBe("unrecoverable");
	});

	it("refuses deleting a tracked-but-dirty BROKEN symlink (lstat, not existsSync)", () => {
		// existsSync follows the link to its dead target and reports false; using it
		// would wrongly clear this as "nothing to lose" even though the uncommitted
		// symlink change is real, unrecoverable content.
		writeFileSync(join(repo, "target.txt"), "t\n");
		symlinkSync("target.txt", join(repo, "link"));
		g("add", "-A");
		g("commit", "-qm", "add link");
		// Repoint the (tracked) symlink at a missing target: now dirty AND broken.
		unlinkSync(join(repo, "link"));
		symlinkSync("does-not-exist", join(repo, "link"));
		expect(checkRecoverability(repo, { targets: [join(repo, "link")], wholeTree: false }).verdict).toBe(
			"unrecoverable",
		);
	});

	it("treats a non-git directory as unrecoverable", () => {
		const plain = mkdtempSync(join(tmpdir(), "cc-plain-"));
		mkdirSync(join(plain, "sub"), { recursive: true });
		writeFileSync(join(plain, "f.txt"), "x\n");
		try {
			expect(checkRecoverability(plain, { targets: [join(plain, "f.txt")], wholeTree: false }).verdict).toBe(
				"unrecoverable",
			);
			expect(checkRecoverability(plain, { targets: [], wholeTree: true }).verdict).toBe("unrecoverable");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
