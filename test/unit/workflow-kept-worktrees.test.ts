/**
 * A workflow agent's kept isolation worktree (it left changes or commits)
 * reaches the progress line, the viewer's agent record and the run report,
 * for a finished agent and for a failed one alike.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../../extensions/workflow/agent-session.ts";
import { buildRunReport, WorkflowRunManager } from "../../extensions/workflow/run-manager.ts";
import { buildDetail } from "../../extensions/workflow/viewer.ts";

vi.mock("../../extensions/workflow/agent-session.ts", () => ({ AgentRunner: { create: vi.fn() } }));

const META = "export const meta = {name: 'kept', description: 'kept worktrees'}\n";

describe("kept workflow worktrees", () => {
	let sessionDir: string;
	let manager: WorkflowRunManager;
	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "workflow-kept-"));
		manager = new WorkflowRunManager();
		vi.mocked(AgentRunner.create).mockResolvedValue({
			dispose: vi.fn(),
			run: async (prompt: string) => {
				if (prompt === "fails") {
					throw Object.assign(new Error("provider exploded"), { keptWorktree: { path: "/tmp/cc-wt-b/tree", branch: "cc-subagent/b" } });
				}
				return { value: "ok", tokens: { input: 1, output: 1, total: 2 }, cost: 0, worktreePath: "/tmp/cc-wt-a/tree", worktreeBranch: "cc-subagent/a" };
			},
		} as never);
	});
	afterEach(() => {
		manager.abortAll("test cleanup");
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("lists them in the report, the progress lines and the agent records", async () => {
		const handle = manager.start({
			script: `${META}await agent('works', {label: 'a', isolation: 'worktree'}); await agent('fails', {label: 'b', isolation: 'worktree'}); return 'done'`,
			args: undefined,
			tokenBudget: null,
			cwd: sessionDir,
			sessionDir,
			defaultModel: undefined,
		});
		await handle.finished;
		expect(handle.status).toBe("completed");

		const report = buildRunReport(handle);
		expect(report).toContain("Worktrees kept with agents' changes or commits");
		expect(report).toContain("- a: /tmp/cc-wt-a/tree (branch cc-subagent/a)");
		expect(report).toContain("- b: /tmp/cc-wt-b/tree (branch cc-subagent/b)");
		expect(handle.recentEvents.some((line) => line.includes("worktree kept at /tmp/cc-wt-a/tree"))).toBe(true);

		const [a] = handle.agents.list();
		expect(a.worktree).toEqual({ path: "/tmp/cc-wt-a/tree", branch: "cc-subagent/a" });
		const detail = buildDetail(a, 80, Date.now(), false).map((line) => line.text);
		expect(detail).toContain("Worktree kept");
		expect(detail.some((text) => text.includes("/tmp/cc-wt-a/tree (branch cc-subagent/a)"))).toBe(true);
	});
});
