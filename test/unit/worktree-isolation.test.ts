import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeIsolation,
	registerWorktreeIsolation,
	releaseWorktreeIsolation,
	worktreeBashWriteGuardReason,
	worktreeGuardFactory,
	worktreeIsolationFor,
	worktreeWriteGuardReason,
} from "../../extensions/lib/worktree-isolation.ts";
import { requireText } from "../../extensions/lib/profile.ts";
import type { WorktreeGuardRefusal } from "../../extensions/worktree/text.ts";
import { captureToolCallHandler } from "./helpers/permission-gate-harness.ts";

/**
 * Worktree isolation for subagents and workflow agents
 * (lib/worktree-isolation.ts): the registry, the guard factory's wiring, and
 * the write guards' decisions as the refusal data the profile words. One
 * Code's wording of the write refusals is tested in
 * profile/test/worktree-isolation-wording.test.ts.
 */

/** A guard's refusal as the factory hands it to the model, in the profile's words. */
const worded = (refusal: WorktreeGuardRefusal) => requireText("worktreeGuard").refusal(refusal);

describe("worktree isolation registry", () => {
	afterEach(() => releaseWorktreeIsolation("/tmp/cc-wt-x/tree"));

	it("resolves a cwd inside a registered worktree, including subdirectories", () => {
		registerWorktreeIsolation("/tmp/cc-wt-x/tree", "/repo");
		expect(worktreeIsolationFor("/tmp/cc-wt-x/tree")).toMatchObject({ worktreePath: "/tmp/cc-wt-x/tree", sharedRoot: "/repo" });
		expect(worktreeIsolationFor("/tmp/cc-wt-x/tree/src")?.sharedRoot).toBe("/repo");
	});

	it("resolves nothing outside a registered worktree, or after release", () => {
		registerWorktreeIsolation("/tmp/cc-wt-x/tree", "/repo");
		expect(worktreeIsolationFor("/repo")).toBeUndefined();
		expect(worktreeIsolationFor("/tmp/cc-wt-x")).toBeUndefined();
		releaseWorktreeIsolation("/tmp/cc-wt-x/tree");
		expect(worktreeIsolationFor("/tmp/cc-wt-x/tree")).toBeUndefined();
	});
});

// The refusal decisions are owned by worktree-guards.test.ts — these tests
// only pin the wiring: the guard factory fires for registered worktrees. Its
// placement BEFORE the permission gate is set by extensionFactories order in
// lib/agent-loader.ts (load-bearing, commented there).
describe("worktreeGuardFactory", () => {
	function guardedCwd(): { handler: ReturnType<typeof captureToolCallHandler>; cwd: string } {
		const cwd = mkdtempSync(join(os.tmpdir(), "wt-guard-cwd-"));
		return { handler: captureToolCallHandler(worktreeGuardFactory(cwd)), cwd };
	}

	it("blocks unverifiable git in a worktree-isolated run", async () => {
		const { handler, cwd } = guardedCwd();
		registerWorktreeIsolation(cwd, "/repo");
		try {
			const result = await handler({
				toolName: "bash",
				input: { command: "git merge-base master feature | xargs git log --oneline -1" },
			});
			expect(result?.block).toBe(true);
			// Not a repository, so the worktrees cannot be listed: refused before any other check.
			expect(result?.reason).toBe(worded({ kind: "gitTarget", worktreePath: cwd, problem: { kind: "unlisted" } }));
		} finally {
			releaseWorktreeIsolation(cwd);
		}
	});

	it("refuses git when the repository's worktrees cannot be listed", async () => {
		const { handler, cwd } = guardedCwd();
		registerWorktreeIsolation(cwd, "/repo");
		try {
			const result = await handler({ toolName: "bash", input: { command: "git status" } });
			expect(result?.block).toBe(true);
			expect(result?.reason).toBe(worded({ kind: "gitTarget", worktreePath: cwd, problem: { kind: "unlisted" } }));
		} finally {
			releaseWorktreeIsolation(cwd);
		}
	});

	it("lets clean git and non-bash tools through", async () => {
		const { handler, cwd } = guardedCwd();
		execFileSync("git", ["init", "-q"], { cwd });
		registerWorktreeIsolation(cwd, "/repo");
		try {
			expect(await handler({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
			expect(await handler({ toolName: "edit", input: { path: `${cwd}/a.ts` } })).toBeUndefined();
		} finally {
			releaseWorktreeIsolation(cwd);
		}
	});

	it("does not guard bash in a run with no registered worktree", async () => {
		const { handler } = guardedCwd();
		expect(
			await handler({ toolName: "bash", input: { command: "git merge-base master feature | xargs git log -1" } }),
		).toBeUndefined();
	});
});

// File writes from an isolated run must land in the worktree: a fork inherits
// a transcript whose paths all point at the shared checkout (SUBAGENT-REVIEW H3).
describe("worktreeWriteGuardReason", () => {
	const base = { cwd: "/tmp/cc-wt-x/tree", isolation: describeIsolation("/tmp/cc-wt-x/tree", "/repo"), home: "/home/u" };

	/** The refusal of a write into the shared checkout, naming the worktree path to use. */
	const sharedWrite = (target: string, mapped: string, inCommand = false) => ({
		kind: "sharedCheckoutWrite",
		worktreePath: "/tmp/cc-wt-x/tree",
		sharedRoot: "/repo",
		target,
		inCommand,
		mapped,
	});

	it("refuses an edit/write/notebook_edit into the shared checkout and names the worktree path to use", () => {
		for (const toolName of ["edit", "write", "notebook_edit"]) {
			expect(worktreeWriteGuardReason({ ...base, toolName, target: "/repo/src/a.ts" }), toolName).toEqual(
				sharedWrite("/repo/src/a.ts", join("/tmp/cc-wt-x/tree", "src", "a.ts")),
			);
		}
	});

	it("lets writes inside the worktree (absolute or relative) and outside the repository through", () => {
		expect(worktreeWriteGuardReason({ ...base, toolName: "edit", target: "/tmp/cc-wt-x/tree/src/a.ts" })).toBeUndefined();
		expect(worktreeWriteGuardReason({ ...base, toolName: "write", target: "src/new.ts" })).toBeUndefined();
		expect(worktreeWriteGuardReason({ ...base, toolName: "write", target: "/elsewhere/notes.md" })).toBeUndefined();
		expect(worktreeWriteGuardReason({ ...base, toolName: "write", target: "~/notes.md" })).toBeUndefined();
	});

	it("keeps the model's spelling in the suggested path (case-folded resolution must not rename A.ts)", () => {
		expect(worktreeWriteGuardReason({ ...base, toolName: "edit", target: "/repo/src/A.ts" })).toEqual(
			sharedWrite("/repo/src/A.ts", join("/tmp/cc-wt-x/tree", "src", "A.ts")),
		);
	});

	it("refuses shell commands that write into the shared checkout, and lets reads through", () => {
		const bash = (command: string) => worktreeBashWriteGuardReason({ command, cwd: base.cwd, isolation: base.isolation, home: base.home });
		expect(bash("echo hi > /repo/notes.txt")).toEqual(sharedWrite("/repo/notes.txt", join("/tmp/cc-wt-x/tree", "notes.txt"), true));
		expect(bash("cp fixed.ts /repo/src/a.ts")).toEqual(sharedWrite("/repo/src/a.ts", join("/tmp/cc-wt-x/tree", "src", "a.ts"), true));
		expect(bash("tee /repo/out.log < in.txt")).toEqual(sharedWrite("/repo/out.log", join("/tmp/cc-wt-x/tree", "out.log"), true));
		expect(bash("cat /repo/README.md")).toBeUndefined();
		expect(bash("echo hi > notes.txt")).toBeUndefined();
		expect(bash("cp fixed.ts /tmp/cc-wt-x/tree/src/a.ts")).toBeUndefined();
		// Interpreters (sed -i, perl, python) are not modelled as writers by the
		// shell analysis; those fall to the permission gate/classifier, not this guard.
		expect(bash("sed -i 's/x/y/' /repo/src/a.ts")).toBeUndefined();
	});

	it("ignores non-writing tools and calls with no path", () => {
		expect(worktreeWriteGuardReason({ ...base, toolName: "read", target: "/repo/src/a.ts" })).toBeUndefined();
		expect(worktreeWriteGuardReason({ ...base, toolName: "edit", target: undefined })).toBeUndefined();
	});

	it("is wired into the guard factory for registered worktrees, on `path` and `file_path`", async () => {
		const cwd = mkdtempSync(join(os.tmpdir(), "wt-guard-cwd-"));
		const handler = captureToolCallHandler(worktreeGuardFactory(cwd));
		registerWorktreeIsolation(cwd, "/repo");
		try {
			expect((await handler({ toolName: "edit", input: { path: "/repo/a.ts" } }))?.block).toBe(true);
			expect((await handler({ toolName: "write", input: { file_path: "/repo/b.ts" } }))?.block).toBe(true);
			expect(await handler({ toolName: "write", input: { path: `${cwd}/b.ts` } })).toBeUndefined();
			expect((await handler({ toolName: "bash", input: { command: "echo x > /repo/c.ts" } }))?.block).toBe(true);
			expect(await handler({ toolName: "bash", input: { command: "cat /repo/c.ts" } })).toBeUndefined();
		} finally {
			releaseWorktreeIsolation(cwd);
		}
	});
});

describe("worktree isolation through symlinks", () => {
	let root: string;
	let worktree: string;
	let shared: string;
	let alias: string;

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(os.tmpdir(), "wt-symlinks-")));
		worktree = join(root, "tree");
		shared = join(root, "shared");
		alias = join(root, "alias");
		mkdirSync(worktree);
		mkdirSync(shared);
	});

	afterEach(() => {
		releaseWorktreeIsolation(worktree);
		releaseWorktreeIsolation(alias);
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses a file write through a worktree symlink into the shared checkout", () => {
		symlinkSync(shared, join(worktree, "shared-link"), "junction");
		const refusal = worktreeWriteGuardReason({
			toolName: "write",
			target: "shared-link/new.txt",
			cwd: worktree,
			isolation: describeIsolation(worktree, shared),
		});
		expect(refusal).toEqual({
			kind: "sharedCheckoutWrite",
			worktreePath: worktree,
			sharedRoot: shared,
			target: "shared-link/new.txt",
			inCommand: false,
			mapped: join(worktree, "new.txt"),
		});
	});

	it("refuses a shell write through a worktree symlink into the shared checkout", () => {
		symlinkSync(shared, join(worktree, "shared-link"), "junction");
		const refusal = worktreeBashWriteGuardReason({
			command: "echo work > shared-link/new.txt",
			cwd: worktree,
			isolation: describeIsolation(worktree, shared),
		});
		expect(refusal).toEqual({
			kind: "sharedCheckoutWrite",
			worktreePath: worktree,
			sharedRoot: shared,
			target: "shared-link/new.txt",
			inCommand: true,
			mapped: join(worktree, "new.txt"),
		});
	});

	it("finds an isolation registered through a symlink when the child cwd is canonical", () => {
		symlinkSync(worktree, alias, "junction");
		registerWorktreeIsolation(alias, shared);
		expect(worktreeIsolationFor(worktree)?.worktreePath).toBe(alias);
	});

	it("finds a canonical isolation when the child cwd uses a symlink", () => {
		symlinkSync(worktree, alias, "junction");
		registerWorktreeIsolation(worktree, shared);
		expect(worktreeIsolationFor(alias)?.worktreePath).toBe(worktree);
	});

	it("keeps the inline guard active when the child's cwd uses a symlink", async () => {
		symlinkSync(worktree, alias, "junction");
		registerWorktreeIsolation(worktree, shared);
		const handler = captureToolCallHandler(worktreeGuardFactory(alias));
		expect((await handler({ toolName: "write", input: { path: join(shared, "new.txt") } }))?.block).toBe(true);
	});

	it("allows a symlink that stays inside the isolated worktree", () => {
		mkdirSync(join(worktree, "src"));
		symlinkSync(join(worktree, "src"), join(worktree, "src-link"), "junction");
		expect(worktreeWriteGuardReason({
			toolName: "write",
			target: "src-link/new.txt",
			cwd: worktree,
			isolation: describeIsolation(worktree, shared),
		})).toBeUndefined();
	});
});

describe.skipIf(process.platform !== "win32")("worktree write guard: Git Bash path spellings on Windows", () => {
	const drive = resolve("/").charAt(0).toLowerCase();
	const isolation = describeIsolation("/tmp/cc-wt-y/tree", "/repo");
	const bash = (command: string) => worktreeBashWriteGuardReason({ command, cwd: "/tmp/cc-wt-y/tree", isolation, home: "/home/u" });

	it("refuses a shell write into the shared checkout spelled /<drive>/repo", () => {
		expect(bash(`echo x > /${drive}/repo/src/a.ts`)).toMatchObject({ kind: "sharedCheckoutWrite", inCommand: true, mapped: join("/tmp/cc-wt-y/tree", "src", "a.ts") });
	});

	it("lets a shell write into the worktree spelled /<drive>/tmp/… through", () => {
		expect(bash(`echo x > /${drive}/tmp/cc-wt-y/tree/src/a.ts`)).toBeUndefined();
	});
});
