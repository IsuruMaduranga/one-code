import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../../extensions/workflow/agent-session.ts";
import { WorkflowRunManager } from "../../extensions/workflow/run-manager.ts";

vi.mock("../../extensions/workflow/agent-session.ts", () => ({ AgentRunner: { create: vi.fn() } }));

const META = "export const meta = {name: 'test', description: 'test'}\n";

describe("workflow worker lifecycle", () => {
	let sessionDir: string;
	let manager: WorkflowRunManager;
	const dispose = vi.fn();
	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "workflow-lifecycle-"));
		manager = new WorkflowRunManager();
		dispose.mockClear();
		vi.mocked(AgentRunner.create).mockResolvedValue({ dispose } as never);
	});
	afterEach(() => {
		manager.abortAll("test cleanup");
		rmSync(sessionDir, { recursive: true, force: true });
	});

	const start = (body: string) => manager.start({
		script: META + body, args: undefined, tokenBudget: null,
		cwd: sessionDir, sessionDir, defaultModel: undefined,
	});

	it.each([false, true])("stops an awaiting script and its nested worker (nested=%s)", async (nested) => {
		let body = "log('ready'); await new Promise(() => {})";
		if (nested) {
			const path = join(sessionDir, "child.js");
			writeFileSync(path, META + body);
			body = `return await workflow({scriptPath: ${JSON.stringify(path)}})`;
		}
		const handle = start(body);
		await new Promise<void>((resolve) => handle.on("progress", (event) => {
			if (event.type === "log" && event.text === "ready") resolve();
		}));
		expect(manager.abort(handle.runId, "user stopped")).toBe(true);
		await handle.finished;
		expect(handle.status).toBe("aborted");
		expect(handle.errorMessage).toBe("user stopped");
		expect(manager.hasActiveRuns()).toBe(false);
		expect(dispose).toHaveBeenCalledOnce();
	});

	it.each([false, true])("cleans up host agent work when the script stops (returns early=%s)", async (returnsEarly) => {
		let reportStarted!: () => void;
		const started = new Promise<void>((resolve) => { reportStarted = resolve; });
		let agentAborted = false;
		vi.mocked(AgentRunner.create).mockResolvedValue({
			dispose,
			run: (_prompt: string, _opts: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => { agentAborted = true; reject(new Error("aborted")); }, { once: true });
				reportStarted();
			}),
		} as never);
		const handle = start(returnsEarly ? "agent('wait'); return 'done'" : "await agent('wait')");
		await started;
		if (!returnsEarly) manager.abortAll("session shutdown");
		await handle.finished;
		expect(handle.status).toBe(returnsEarly ? "completed" : "aborted");
		expect(agentAborted).toBe(true);
		expect(dispose).toHaveBeenCalledOnce();
	});
});
