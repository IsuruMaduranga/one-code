import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerWorktreeIsolation,
	releaseWorktreeIsolation,
	worktreeGuardFactory,
	worktreeIsolationFor,
} from "../../extensions/lib/worktree-isolation.ts";
import { captureToolCallHandler } from "./helpers/permission-gate-harness.ts";

describe("worktree isolation registry", () => {
	afterEach(() => releaseWorktreeIsolation("/tmp/cc-wt-x/tree"));

	it("resolves a cwd inside a registered worktree, including subdirectories", () => {
		registerWorktreeIsolation("/tmp/cc-wt-x/tree", "/repo");
		expect(worktreeIsolationFor("/tmp/cc-wt-x/tree")).toEqual({ worktreePath: "/tmp/cc-wt-x/tree", sharedRoot: "/repo" });
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

// The exact refusal wording is owned by worktree-guards.test.ts — these tests
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
			expect(result?.reason).toContain(`isolated in the worktree ${cwd}`);
		} finally {
			releaseWorktreeIsolation(cwd);
		}
	});

	it("lets clean git and non-bash tools through", async () => {
		const { handler, cwd } = guardedCwd();
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
