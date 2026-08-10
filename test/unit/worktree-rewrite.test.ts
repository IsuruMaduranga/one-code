import { describe, expect, it } from "vitest";
import { ORIGINAL_COMMAND_KEY, rewriteToolInput, shellQuote, validateWorktreeName } from "../../extensions/worktree/rewrite.ts";

const WT = "/repo/.claude/worktrees/fix";

describe("rewriteToolInput", () => {
	it("prefixes bash commands with a cd into the worktree", () => {
		const input: Record<string, unknown> = { command: "npm test" };
		rewriteToolInput("bash", input, WT);
		expect(input.command).toBe(`cd '${WT}' && (npm test\n)`);
	});

	it("preserves the original bash command so permission rules still match it", () => {
		// Without this, the cd-wrapper defeats every configured Bash allow/ask/deny
		// rule for the duration of the worktree session.
		const input: Record<string, unknown> = { command: "npm run test:unit" };
		rewriteToolInput("bash", input, WT);
		expect(input[ORIGINAL_COMMAND_KEY]).toBe("npm run test:unit");
	});

	it("resolves relative paths against the worktree and leaves absolute ones alone", () => {
		const relative: Record<string, unknown> = { path: "src/index.ts" };
		rewriteToolInput("edit", relative, WT);
		expect(relative.path).toBe(`${WT}/src/index.ts`);

		const absolute: Record<string, unknown> = { path: "/etc/hosts" };
		rewriteToolInput("read", absolute, WT);
		expect(absolute.path).toBe("/etc/hosts");
	});

	it("defaults a missing path to the worktree for cwd-scoped tools only", () => {
		const ls: Record<string, unknown> = {};
		rewriteToolInput("ls", ls, WT);
		expect(ls.path).toBe(WT);

		const grep: Record<string, unknown> = { pattern: "x" };
		rewriteToolInput("grep", grep, WT);
		expect(grep.path).toBe(WT);

		const read: Record<string, unknown> = {};
		rewriteToolInput("read", read, WT);
		expect(read.path).toBeUndefined();
	});

	it("ignores tools that take no paths", () => {
		const input: Record<string, unknown> = { query: "select:Read" };
		rewriteToolInput("tool_search", input, WT);
		expect(input).toEqual({ query: "select:Read" });
	});

	it("shell-quotes worktree paths containing single quotes", () => {
		expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\\''s here'");
	});
});

describe("validateWorktreeName", () => {
	it("accepts plain and slash-separated names", () => {
		expect(validateWorktreeName("fix-bug_2.0")).toBeUndefined();
		expect(validateWorktreeName("feature/login")).toBeUndefined();
	});

	it("rejects bad characters, dot segments, and over-long names", () => {
		expect(validateWorktreeName("has space")).toBeDefined();
		expect(validateWorktreeName("a/../b")).toBeDefined();
		expect(validateWorktreeName("x".repeat(65))).toBeDefined();
		expect(validateWorktreeName("")).toBeDefined();
	});
});
