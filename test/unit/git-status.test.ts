import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectGitStatus, formatGitStatus, type GitRunner } from "../../extensions/system-prompt/git-status.ts";

/** A fake git runner keyed by the space-joined argv. */
function fakeRunner(map: Record<string, string>): GitRunner {
	return (args) => {
		const key = args.join(" ");
		return key in map ? map[key] : null;
	};
}

describe("formatGitStatus", () => {
	it("assembles CC's block byte-for-byte", () => {
		const block = formatGitStatus({
			branch: "feature/x",
			mainBranch: "main",
			user: "Ada Lovelace",
			status: "M src/a.ts\n?? new.txt",
			commits: "abc123 First\ndef456 Second",
		});
		expect(block).toBe(
			[
				"gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
				"",
				"Current branch: feature/x",
				"",
				"Main branch (you will usually use this for PRs): main",
				"",
				"Git user: Ada Lovelace",
				"",
				"Status:",
				"M src/a.ts",
				"?? new.txt",
				"",
				"Recent commits:",
				"abc123 First",
				"def456 Second",
			].join("\n"),
		);
	});
});

describe("collectGitStatus", () => {
	const base = {
		"rev-parse --is-inside-work-tree": "true",
		"branch --show-current": "feature/x",
		"config user.name": "Ada",
		"status --porcelain": "M a.ts",
		"log -5 --format=%h %s": "abc First",
	};

	it("returns null outside a git work tree", () => {
		expect(collectGitStatus("/x", fakeRunner({}))).toBeNull();
	});

	it("derives the main branch from origin/HEAD, stripping the origin/ prefix", () => {
		const block = collectGitStatus(
			"/x",
			fakeRunner({ ...base, "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk" }),
		);
		expect(block).toContain("Main branch (you will usually use this for PRs): trunk");
		expect(block).toContain("Current branch: feature/x");
	});

	it("falls back to a local main, then master, then the current branch", () => {
		const withMain = fakeRunner({ ...base, "rev-parse --verify --quiet main": "sha" });
		expect(collectGitStatus("/x", withMain)).toContain("PRs): main");

		const withMaster = fakeRunner({ ...base, "rev-parse --verify --quiet master": "sha" });
		expect(collectGitStatus("/x", withMaster)).toContain("PRs): master");

		// No origin/HEAD and no local main/master: the current branch stands in.
		expect(collectGitStatus("/x", fakeRunner(base))).toContain("PRs): feature/x");
	});

	it("degrades a failing field to empty rather than dropping the block", () => {
		const noUser = { ...base };
		delete (noUser as Record<string, string>)["config user.name"];
		const block = collectGitStatus("/x", fakeRunner(noUser));
		expect(block).toContain("Git user: \n");
	});
});

// Byte-exact validation against a real CC capture (internal-only; skipped where
// absent, as in the public repo / CI).
describe("against git-cc-sonnet.json capture", () => {
	const capturePath = fileURLToPath(new URL("../../git-cc-sonnet.json", import.meta.url));
	const run = existsSync(capturePath) ? it : it.skip;

	run("formatGitStatus reproduces the captured gitStatus block from its fields", () => {
		const payload = JSON.parse(readFileSync(capturePath, "utf8"));
		const sys: string = payload.system
			.map((b: { text?: string }) => b.text ?? "")
			.join("\n");
		const block = sys.slice(sys.indexOf("gitStatus:"));
		expect(block).toBeTruthy();

		// Parse the fields back out and re-format; equality proves labels + spacing.
		const branch = /Current branch: (.*)/.exec(block)?.[1] ?? "";
		const mainBranch = /Main branch \(you will usually use this for PRs\): (.*)/.exec(block)?.[1] ?? "";
		const user = /Git user: (.*)/.exec(block)?.[1] ?? "";
		const status = block.slice(block.indexOf("Status:\n") + "Status:\n".length, block.indexOf("\n\nRecent commits:"));
		const commits = block.slice(block.indexOf("Recent commits:\n") + "Recent commits:\n".length);

		expect(formatGitStatus({ branch, mainBranch, user, status, commits })).toBe(block);
	});
});
