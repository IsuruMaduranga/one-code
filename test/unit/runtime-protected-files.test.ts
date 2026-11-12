/**
 * The settings files a source provider adds are protected in every mode
 * (lib/agents/permission-gate.ts `runtimeProtectedFiles`), not only by the
 * auto-mode floor: the static list knows One Code's and Claude Code's files
 * by name, a product's provider may name its own anything.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { protectedPathsByCwd, runtimeProtectedDirs, runtimeProtectedFiles } from "../../extensions/lib/agents/permission-gate.ts";
import { decide, parseRules } from "../../extensions/lib/rules/matcher.ts";
import { isProtectedPath } from "../../extensions/lib/rules/protected-paths.ts";
import { borrowedLadderPaths, useBorrowedLadder } from "./helpers/settings-files.ts";

useBorrowedLadder();

let root: string;
let cwd: string;
let home: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "protected-files-"));
	cwd = join(root, "project");
	home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("runtimeProtectedFiles", () => {
	it("lists every file of the settings ladder, the provider's included", () => {
		const files = runtimeProtectedFiles(cwd, home);
		for (const path of Object.values(borrowedLadderPaths(cwd, home))) expect(files, path).toContain(path);
	});

	it("follows the call's own directory: a worktree's copy of the project file is protected there", () => {
		const worktree = join(root, "worktree");
		mkdirSync(worktree, { recursive: true });
		const protectedFor = protectedPathsByCwd(home);
		const copy = borrowedLadderPaths(worktree, home).project;
		expect(protectedFor(cwd)).not.toContain(copy);
		expect(protectedFor(worktree)).toContain(copy);
		expect(protectedFor(worktree)).toBe(protectedFor(worktree));
		const call = { toolName: "write", subject: copy, cwd: worktree, deny: [], ask: [], allow: [], workspaceDirs: [] as string[], mode: "acceptEdits" as const };
		expect(decide({ ...call, protectedDirs: protectedFor(cwd) }).decision).toBe("allow");
		expect(decide({ ...call, protectedDirs: protectedFor(worktree) })).toMatchObject({ decision: "ask", cause: "protected-path" });
	});

	it("makes a write to a provider's settings file ask where the edit would otherwise be allowed", () => {
		const { project, user } = borrowedLadderPaths(cwd, home);
		// The premise: nothing in the static list knows these names.
		expect(isProtectedPath(project, cwd)).toBe(false);
		const call = { toolName: "write", subject: project, cwd, deny: [], ask: [], allow: [], workspaceDirs: [] as string[] };
		expect(decide({ ...call, mode: "acceptEdits", protectedDirs: runtimeProtectedDirs() }).decision).toBe("allow");
		const protectedDirs = [...runtimeProtectedDirs(), ...runtimeProtectedFiles(cwd, home)];
		expect(decide({ ...call, mode: "acceptEdits", protectedDirs })).toMatchObject({ decision: "ask", cause: "protected-path" });
		expect(decide({ ...call, mode: "auto", protectedDirs })).toMatchObject({ decision: "classify", cause: "protected-path" });
		expect(decide({ ...call, mode: "dontAsk", protectedDirs })).toMatchObject({ decision: "deny", cause: "protected-path" });
		// An allow rule cannot pre-approve it either.
		const allowed = decide({ ...call, subject: user, mode: "default", allow: parseRules(["Write(**)"]), protectedDirs });
		expect(allowed.decision).not.toBe("allow");
	});
});
