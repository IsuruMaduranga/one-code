/**
 * After `enter_worktree`, pi keeps ctx.cwd at the original checkout, so the
 * subagents and workflow extensions follow WORKTREE_CHANNEL and spawn their
 * children in the entered worktree, guarded there like an isolated run.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionWorkCwd, WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { followEnteredWorktree, releaseWorktreeIsolation, worktreeIsolationFor } from "../../extensions/lib/worktree-isolation.ts";
import * as defaults from "../../extensions/subagents/default-model.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { SubagentRuntime } from "../../extensions/subagents/runner.ts";
import { emptyUsage } from "../../extensions/subagents/usage.ts";
import workflowExtension from "../../extensions/workflow/index.ts";
import { WorkflowRunManager } from "../../extensions/workflow/run-manager.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const model = { provider: "anthropic", id: "claude-sonnet-5", name: "s", input: ["text"], cost: { input: 3, output: 15 } };
let dir: string;
let worktree: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "entered-wt-"));
	worktree = join(dir, ".claude", "worktrees", "feature");
	mkdirSync(worktree, { recursive: true });
	vi.spyOn(defaults, "loadSubagentDefault").mockReturnValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	releaseWorktreeIsolation(worktree);
	rmSync(dir, { recursive: true, force: true });
});

const ctxFor = (mode: string) =>
	createFakeCtx({
		cwd: dir,
		mode,
		model,
		modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true }) },
		sessionManager: { getSessionId: () => "s", getSessionDir: () => dir, getSessionFile: () => undefined, getBranch: () => [] },
	});

describe("sessionWorkCwd", () => {
	it("is the entered worktree while it exists, else the session cwd", () => {
		expect(sessionWorkCwd({ path: worktree }, dir)).toBe(worktree);
		expect(sessionWorkCwd(null, dir)).toBe(dir);
		expect(sessionWorkCwd({ path: join(dir, "gone") }, dir)).toBe(dir);
	});
});

describe("followEnteredWorktree", () => {
	it("tracks the channel and registers the worktree for the child guards", () => {
		const fake = createFakePi();
		const entered = followEnteredWorktree(fake.events);
		fake.events.emit(WORKTREE_CHANNEL, { path: worktree, branch: "feature", sharedRoot: dir });
		expect(entered()?.path).toBe(worktree);
		expect(worktreeIsolationFor(join(worktree, "src"))).toMatchObject({ worktreePath: worktree, sharedRoot: dir });
		fake.events.emit(WORKTREE_CHANNEL, null);
		expect(entered()).toBeUndefined();
	});
});

describe("Agent spawns after enter_worktree", () => {
	it("run the child in the entered worktree", async () => {
		const seen: string[] = [];
		vi.spyOn(SubagentRuntime, "create").mockResolvedValue({
			runResident: async (options: { cwd: string }) => {
				seen.push(options.cwd);
				return {
					send: async () => "started",
					busy: () => true,
					exited: () => false,
					snapshot: () => ({ text: "", toolCalls: 0, usage: emptyUsage() }),
					release() {},
					kill: async () => {},
				};
			},
			run: vi.fn(),
		} as never);
		const fake = createFakePi();
		subagentsExtension(fake.pi as never);
		const ctx = ctxFor("tui");
		await fake.fire("session_start", {}, ctx);
		fake.events.emit(WORKTREE_CHANNEL, { path: worktree, branch: "feature", sharedRoot: dir });
		await fake.tools.get("Agent")!.execute("c1", { subagent_type: "general-purpose", task: "edit src/a.ts" }, undefined, undefined, ctx);
		expect(seen).toEqual([worktree]);

		fake.events.emit(WORKTREE_CHANNEL, null);
		await fake.tools.get("Agent")!.execute("c2", { subagent_type: "general-purpose", task: "edit src/b.ts" }, undefined, undefined, ctx);
		expect(seen).toEqual([worktree, dir]);
		await fake.fire("session_shutdown", {}, ctx);
	});
});

describe("workflow runs after enter_worktree", () => {
	it("give their agents the entered worktree as cwd", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "entered-wt-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const start = vi.spyOn(WorkflowRunManager.prototype, "start");
		try {
			const fake = createFakePi();
			workflowExtension(fake.pi as never);
			fake.events.emit(WORKTREE_CHANNEL, { path: worktree, branch: "feature", sharedRoot: dir });
			const script = "export const meta = { name: 'cwd-probe', description: 'returns a value' }\nreturn 1";
			await fake.tools.get("workflow")!.execute("c1", { script }, undefined, undefined, ctxFor("json"));
			expect(start.mock.calls[0]?.[0]).toMatchObject({ cwd: worktree });
		} finally {
			vi.unstubAllEnvs();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
