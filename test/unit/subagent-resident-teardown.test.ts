/**
 * A resident's kill() settles only after its onExit work (worktree cleanup)
 * has finished, so session_shutdown's bounded wait covers the cleanup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as defaults from "../../extensions/lib/models/subagent-default.ts";
import subagentsExtension from "../../extensions/agents/subagents/index.ts";
import { LiveRunRegistry } from "../../extensions/agents/subagents/live-runs.ts";
import type { ChildOutcome } from "../../extensions/agents/subagents/outcome.ts";
import { SubagentRuntime } from "../../extensions/agents/subagents/runner.ts";
import { emptyUsage } from "../../extensions/lib/agents/usage.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { initTestRepo } from "./helpers/git-repo.ts";

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "resident-teardown-agent-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

function fakeSession() {
	return {
		subscribe: () => () => {},
		abort: async () => {},
		dispose: vi.fn(),
		isIdle: true,
		sessionManager: { getSessionId: () => "child" },
	};
}

describe("blocking run startup cancellation", () => {
	it.each(["build", "prefix"])("does not prompt after kill() during the %s wait", async (wait) => {
		const runtime = await SubagentRuntime.create(agentDir);
		const session = { ...fakeSession(), prompt: vi.fn(async () => {}) };
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const releasePrefix = vi.fn();
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockImplementation(async () => {
			if (wait === "build") await pending;
			return { session } as never;
		});
		vi.spyOn(SubagentRuntime.prototype as never, "admitPrefix").mockImplementation(async () => {
			if (wait === "prefix") await pending;
			return releasePrefix as never;
		});
		const handle = runtime.run({ cwd: agentDir, task: "must not run", onProgress: () => {} });
		await Promise.resolve();
		handle.kill();
		release();
		const result = await handle.result;
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(result.failed).toBe(true);
	});
});

describe("resident kill()", () => {
	it("waits for the onExit cleanup before it settles", async () => {
		const runtime = await SubagentRuntime.create(agentDir);
		const session = fakeSession();
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session, note: undefined } as never);
		let finishCleanup!: () => void;
		let cleanedUp = false;
		const handle = await runtime.runResident({
			name: "worker",
			cwd: agentDir,
			onProgress: () => {},
			onTurnEnd: () => {},
			onExit: () =>
				new Promise<void>((resolve) => {
					finishCleanup = () => {
						cleanedUp = true;
						resolve();
					};
				}),
		} as never);

		let settled = false;
		const killed = Promise.resolve(handle.kill()).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(settled).toBe(false);

		finishCleanup();
		await killed;
		expect(cleanedUp).toBe(true);
		expect(settled).toBe(true);
	});

	it("a repeated kill still waits for the in-flight cleanup", async () => {
		const runtime = await SubagentRuntime.create(agentDir);
		const session = fakeSession();
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session } as never);
		let finishCleanup!: () => void;
		const handle = await runtime.runResident({
			cwd: agentDir,
			onProgress: () => {},
			onTurnEnd: () => {},
			onExit: () => new Promise<void>((resolve) => { finishCleanup = resolve; }),
		});
		const first = handle.kill();
		let settled = false;
		const second = handle.kill().then(() => { settled = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		finishCleanup();
		await Promise.all([first, second]);
		expect(settled).toBe(true);
	});

	it("still settles when the onExit work fails", async () => {
		const runtime = await SubagentRuntime.create(agentDir);
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session: fakeSession(), note: undefined } as never);
		const handle = await runtime.runResident({
			name: "worker",
			cwd: agentDir,
			onProgress: () => {},
			onTurnEnd: () => {},
			onExit: () => Promise.reject(new Error("git broke")),
		} as never);
		await expect(handle.kill()).resolves.toBeUndefined();
	});
});

describe("an isolated resident's exit", () => {
	it("returns its worktree cleanup, so kill() can wait for it", async () => {
		const repo = mkdtempSync(join(tmpdir(), "resident-teardown-repo-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		initTestRepo(repo);
		writeFileSync(join(repo, "a.txt"), "a\n");
		git("add", "a.txt");
		git("commit", "-qm", "init");
		try {
			vi.spyOn(defaults, "loadSubagentDefault").mockReturnValue(undefined);
			let options: { cwd: string; onExit?: () => unknown } | undefined;
			vi.spyOn(SubagentRuntime, "create").mockResolvedValue({
				runResident: async (opts: typeof options) => {
					options = opts;
					return { send: async () => "started", busy: () => true, exited: () => false, snapshot: () => ({ text: "", toolCalls: 0, usage: emptyUsage() }), release() {}, kill: async () => {} };
				},
				run: vi.fn(),
			} as never);
			const model = { provider: "anthropic", id: "claude-sonnet-5", name: "s", input: ["text"], cost: { input: 3, output: 15 } };
			const ctx = createFakeCtx({
				cwd: repo,
				mode: "tui",
				model,
				modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true }) },
				sessionManager: { getSessionId: () => "s", getSessionDir: () => repo, getSessionFile: () => undefined, getBranch: () => [] },
			});
			const fake = createFakePi();
			subagentsExtension(fake.pi as never);
			await fake.fire("session_start", {}, ctx);
			await fake.tools.get("Agent")!.execute("c1", { subagent_type: "general-purpose", task: "look", isolation: "worktree" }, undefined, undefined, ctx);
			const worktree = options!.cwd;
			expect(existsSync(worktree)).toBe(true);
			const exit = options!.onExit!();
			expect(exit).toBeInstanceOf(Promise);
			await exit;
			expect(existsSync(worktree)).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

// A stop can land after pi has ended the turn's run but before its settle event
// reaches the tracker (pi awaits the child's agent_settled handlers first). The
// kill cut nothing short there, so the turn keeps its own outcome; a stop of
// every agent then delivers that report instead of dropping it as stopped.
describe("a kill as the turn ends on its own", () => {
	type Listener = (event: unknown) => void;
	function scriptedSession() {
		let listener: Listener = () => {};
		let finishPrompt!: () => void;
		const session = {
			...fakeSession(),
			isIdle: true,
			subscribe: (l: Listener) => {
				listener = l;
				return () => {};
			},
			prompt: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishPrompt = resolve;
					}),
			),
		};
		const reply = (text: string) =>
			listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: emptyUsage() } });
		/** pi's run: started, replied, and (when `ended`) idle again with its settle event still pending. */
		const run = (text: string, ended: boolean) => {
			session.isIdle = false;
			listener({ type: "agent_start" });
			reply(text);
			if (ended) session.isIdle = true;
		};
		/** pi's message_end for the reply an abort cut short. */
		const abortedReply = () =>
			listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Halfway" }], stopReason: "aborted", usage: emptyUsage() } });
		/** pi's settle event for the run that ended. */
		const settle = () => listener({ type: "agent_settled" });
		return { session, run, abortedReply, settle, finishPrompt: () => finishPrompt() };
	}

	async function resident() {
		const runtime = await SubagentRuntime.create(agentDir);
		const scripted = scriptedSession();
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session: scripted.session, note: undefined } as never);
		vi.spyOn(SubagentRuntime.prototype as never, "admitPrefix").mockResolvedValue((() => {}) as never);
		const outcomes: Array<{ output: string; failed?: boolean; aborted?: string }> = [];
		const handle = await runtime.runResident({ name: "worker", cwd: agentDir, onProgress: () => {}, onTurnEnd: (outcome: ChildOutcome) => outcomes.push(outcome) } as never);
		await handle.send("Build it");
		await vi.waitFor(() => expect(scripted.session.prompt).toHaveBeenCalled());
		return { handle, outcomes, ...scripted };
	}

	it("reports a resident turn pi already ended as it ended", async () => {
		const { handle, outcomes, run } = await resident();
		run("The integration is built.", true);
		await handle.kill();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].output).toBe("The integration is built.");
		expect(outcomes[0].failed).toBeUndefined();
		expect(outcomes[0].aborted).toBeUndefined();
	});

	it("still reports a resident turn the kill cut short as stopped", async () => {
		const { handle, outcomes, run } = await resident();
		run("Halfway there.", false);
		await handle.kill();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].failed).toBe(true);
		expect(outcomes[0].aborted).toBe("stopped");
	});

	it("drives the strip row from the turn: running at its start, idle at its end, not woken by the abort's late message_end", async () => {
		const runtime = await SubagentRuntime.create(agentDir);
		const scripted = scriptedSession();
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session: scripted.session, note: undefined } as never);
		vi.spyOn(SubagentRuntime.prototype as never, "admitPrefix").mockResolvedValue((() => {}) as never);
		const live = new LiveRunRegistry();
		live.register({ taskId: "r1", name: "worker", agentType: "general-purpose", task: "Build it", startedAt: 0 });
		const turnStarts = vi.fn(() => live.wake("r1"));
		const handle = await runtime.runResident({
			name: "worker",
			cwd: agentDir,
			onProgress: () => {},
			onTurnStart: turnStarts,
			onTurnEnd: () => live.settle("r1"),
			sink: { onStreaming: (message: { content?: unknown } | undefined) => live.setStreaming("r1", message) },
		} as never);
		await handle.send("Build it");
		expect(turnStarts).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(scripted.session.prompt).toHaveBeenCalled());
		scripted.run("Halfway there.", false);
		// A turn reported early (the wall-clock cap, a stop) settles the row before pi's abort lands.
		void handle.kill();
		expect(live.get("r1")!.status).toBe("idle");
		scripted.abortedReply();
		expect(live.get("r1")!.status).toBe("idle");
	});

	it("wakes an idle resident's row when a SendMessage starts its next turn, before the child's first event", async () => {
		const runtime = await SubagentRuntime.create(agentDir);
		const scripted = scriptedSession();
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session: scripted.session, note: undefined } as never);
		vi.spyOn(SubagentRuntime.prototype as never, "admitPrefix").mockResolvedValue((() => {}) as never);
		const live = new LiveRunRegistry();
		live.register({ taskId: "r1", name: "worker", agentType: "general-purpose", task: "Build it", startedAt: 0 });
		const handle = await runtime.runResident({
			name: "worker",
			cwd: agentDir,
			onProgress: () => {},
			onTurnStart: () => live.wake("r1"),
			onTurnEnd: () => live.settle("r1"),
		} as never);
		await handle.send("Build it");
		await vi.waitFor(() => expect(scripted.session.prompt).toHaveBeenCalled());
		scripted.run("Built.", true);
		scripted.settle();
		expect(live.get("r1")!.status).toBe("idle");
		await handle.send("Now the tests");
		expect(live.get("r1")!.status).toBe("running");
	});

	it("reports a blocking run pi already ended as it ended", async () => {
		const runtime = await SubagentRuntime.create(agentDir);
		const scripted = scriptedSession();
		vi.spyOn(SubagentRuntime.prototype as never, "buildChildSession").mockResolvedValue({ session: scripted.session } as never);
		vi.spyOn(SubagentRuntime.prototype as never, "admitPrefix").mockResolvedValue((() => {}) as never);
		const handle = runtime.run({ cwd: agentDir, task: "Check again", onProgress: () => {} });
		await vi.waitFor(() => expect(scripted.session.prompt).toHaveBeenCalled());
		scripted.run("All checks pass.", true);
		handle.kill();
		scripted.finishPrompt();
		const result = await handle.result;
		expect(result.output).toBe("All checks pass.");
		expect(result.aborted).toBeUndefined();
	});
});
