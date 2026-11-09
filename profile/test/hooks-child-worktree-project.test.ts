/**
 * A child session's hooks with One Code's source provider on: a project
 * hook in Claude Code's `.claude/settings.json`, approved in the parent, runs
 * for a child in a worktree, in the child's cwd. The base's child hooks:
 * test/unit/hooks-child-worktree.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashProjectHooks, persistApproval, resetTrustSessionState } from "../../extensions/safety/hooks/trust.ts";
import { childHookBridge, makeHookWorktreeDirs, writeHookScript } from "../../test/unit/helpers/hook-worktree.ts";

const state = vi.hoisted(() => ({ home: `/nonexistent/one-code-child-hooks-${Math.random().toString(36).slice(2)}` }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.home, default: { ...actualDefault, homedir: () => state.home } };
});

describe("child hooks in a worktree, with Claude Code's project settings", () => {
	let root: string;
	let parent: string;
	let worktree: string;

	beforeEach(() => {
		({ root, project: parent, worktree } = makeHookWorktreeDirs("hooks-child-worktree-"));
		resetTrustSessionState();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetTrustSessionState();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps the parent's approved project hook settings when the child cwd differs", async () => {
		const record = join(root, "project-cwd.txt");
		const command = writeHookScript(root, "project-hook", `process.stdin.resume(); require("node:fs").writeFileSync(${JSON.stringify(record)}, process.cwd());`);
		const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command }] }] };
		mkdirSync(join(parent, ".claude"));
		const path = join(parent, ".claude", "settings.json");
		writeFileSync(path, JSON.stringify({ hooks }));
		persistApproval(parent, hashProjectHooks([{ scope: "project", path, config: hooks }]));
		const childHooks = await childHookBridge(parent);
		await childHooks.preToolUse({ toolName: "bash", input: { command: "pwd" }, cwd: worktree, sessionId: "child" });
		expect(readFileSync(record, "utf8")).toBe(worktree);
	});
});
