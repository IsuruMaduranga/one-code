/**
 * A workflow agent's kept isolation worktree (it left changes or commits)
 * reaches the progress line, the viewer's agent record and the run report,
 * for a finished agent and for a failed one alike.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../../extensions/agents/workflow/agent-session.ts";
import { buildRunReport, WorkflowRunManager } from "../../extensions/agents/workflow/run-manager.ts";
import { buildDetail } from "../../extensions/agents/workflow/viewer.ts";
import { workflowResultText } from "../../extensions/agents/workflow/text.ts";
import { PERSIST_MAX_BYTES } from "../../extensions/lib/request/persisted-output.ts";

vi.mock("../../extensions/agents/workflow/agent-session.ts", () => ({ AgentRunner: { create: vi.fn() } }));

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

		expect(buildRunReport(handle)).toBe(
			workflowResultText.report({
				name: "kept",
				runId: handle.runId,
				status: "completed",
				stats: { agents: 2, outputTokens: 1, cost: 0 },
				seconds: Math.round((handle.finishedAt! - handle.startedAt) / 1000),
				result: "done",
				progress: [],
				keptWorktrees: [
					{ label: "a", path: "/tmp/cc-wt-a/tree", branch: "cc-subagent/a" },
					{ label: "b", path: "/tmp/cc-wt-b/tree", branch: "cc-subagent/b" },
				],
			}),
		);
		expect(handle.recentEvents.some((line) => line.includes(workflowResultText.progress.worktreeKept({ path: "/tmp/cc-wt-a/tree" })))).toBe(true);

		const [a] = handle.agents.list();
		expect(a.worktree).toEqual({ path: "/tmp/cc-wt-a/tree", branch: "cc-subagent/a" });
		const detail = buildDetail(a, 80, Date.now(), false).map((line) => line.text);
		expect(detail).toContain("Worktree kept");
		expect(detail.some((text) => text.includes("/tmp/cc-wt-a/tree (branch cc-subagent/a)"))).toBe(true);
	});
	// Never truncated: a value too large to send whole is saved under the run's
	// directory, inside the session's, and the report says where.
	it("persists a script value too large for the report and names the file", async () => {
		const handle = manager.start({
			script: `${META}return 'r'.repeat(${PERSIST_MAX_BYTES} + 1)`,
			args: undefined,
			tokenBudget: null,
			cwd: sessionDir,
			sessionDir,
			defaultModel: undefined,
		});
		await handle.finished;
		expect(handle.status).toBe("completed");

		const file = join(handle.runDir, "tool-results", "result.txt");
		const report = buildRunReport(handle);
		expect(report).toContain(file);
		expect(report.length).toBeLessThan(PERSIST_MAX_BYTES / 2);
		expect(readFileSync(file, "utf8")).toBe("r".repeat(PERSIST_MAX_BYTES + 1));
		expect(handle.runDir.startsWith(sessionDir)).toBe(true);
		// Built once: the notification and the tool result carry the same block, and the file is not written again.
		rmSync(file);
		expect(buildRunReport(handle)).toBe(report);
		expect(existsSync(file)).toBe(false);
	});

	// A failed save is not kept: the next report writes the file and is the one kept.
	it("retries a failed save of the script value on the next report, then keeps the saved block", async () => {
		const handle = manager.start({
			script: `${META}return 'r'.repeat(${PERSIST_MAX_BYTES} + 1)`,
			args: undefined,
			tokenBudget: null,
			cwd: sessionDir,
			sessionDir,
			defaultModel: undefined,
		});
		await handle.finished;
		expect(handle.status).toBe("completed");

		// A plain file where the tool-results folder goes makes the write fail.
		const folder = join(handle.runDir, "tool-results");
		const file = join(folder, "result.txt");
		rmSync(folder, { recursive: true, force: true });
		mkdirSync(handle.runDir, { recursive: true });
		writeFileSync(folder, "blocker");
		const failed = buildRunReport(handle);
		expect(failed).toContain("could not be saved");

		rmSync(folder);
		const report = buildRunReport(handle);
		expect(report).not.toContain("could not be saved");
		expect(report).toContain(file);
		expect(readFileSync(file, "utf8")).toBe("r".repeat(PERSIST_MAX_BYTES + 1));

		rmSync(folder, { recursive: true });
		expect(buildRunReport(handle)).toBe(report);
		expect(existsSync(folder)).toBe(false);
	});
});
