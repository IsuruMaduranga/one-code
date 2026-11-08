/**
 * Project hooks with One Code's source provider on (Claude Code's
 * `.claude/settings.json`): discovery and consent stay at the parent
 * checkout while the hook runs in the entered worktree. The base's worktree
 * hook cwd: test/unit/hooks-worktree.test.ts.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/hooks/index.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { createFakeCtx, createFakePi, type FakePi } from "../../test/unit/helpers/fake-pi.ts";
import { makeHookWorktreeDirs, readObservations, writeObserverHook } from "../../test/unit/helpers/hook-worktree.ts";

const state = vi.hoisted(() => ({ home: `/nonexistent/one-code-hooks-worktree-${Math.random().toString(36).slice(2)}` }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => state.home, default: { ...actual, homedir: () => state.home } };
});

let root: string;
let project: string;
let worktree: string;
let observations: string;
let command: string;
let fake: FakePi;

beforeEach(() => {
	({ root, project, worktree } = makeHookWorktreeDirs("hooks-worktree-"));
	({ command, observations } = writeObserverHook(root));
	fake = createFakePi();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

/** The observer hook's runs, in order. */
const seen = () => readObservations(observations);
const enter = () => fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: project });

describe("worktree hook cwd with Claude Code's project settings", () => {
	it("keeps project hook discovery and consent at the parent even when the worktree has different settings", async () => {
		for (const dir of [project, worktree]) mkdirSync(join(dir, ".claude"));
		writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }));
		writeFileSync(join(worktree, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }] } }));
		const confirm = vi.fn(async () => true);
		const ctx = createFakeCtx({ cwd: project, hasUI: true, ui: { confirm } });
		hooksExtension(fake.pi as never);
		enter();
		const [result] = await fake.fire("tool_call", { toolName: "bash", toolCallId: "project-hook", input: { command: "pwd" } }, ctx);
		expect(result).toBeUndefined();
		expect(confirm).toHaveBeenCalledOnce();
		expect(seen()).toHaveLength(1);
		expect(seen()[0]).toMatchObject({ cwd: worktree, projectDir: project, payload: { cwd: worktree } });
	});

	it("reserves startup hook consent before yielding but captures cwd after worktree restoration", async () => {
		mkdirSync(join(project, ".claude"));
		writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }));
		const confirm = vi.fn(async () => true);
		const ctx = createFakeCtx({ cwd: project, hasUI: true, ui: { confirm } });
		hooksExtension(fake.pi as never);
		(fake.pi.on as (event: string, handler: () => void) => void)("session_start", enter);
		const starting = fake.fire("session_start", { reason: "resume" }, ctx);
		expect(confirm).toHaveBeenCalledOnce();
		await starting;
		await fake.fire("before_agent_start", { prompt: "continue" }, ctx);
		expect(seen()).toHaveLength(1);
		expect(seen()[0]).toMatchObject({ cwd: worktree, projectDir: project, payload: { cwd: worktree } });
	});
});
