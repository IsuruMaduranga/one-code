/**
 * A resident's kill() settles only after its onExit work (worktree cleanup)
 * has finished, so session_shutdown's bounded wait covers the cleanup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as defaults from "../../extensions/subagents/default-model.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { SubagentRuntime } from "../../extensions/subagents/runner.ts";
import { emptyUsage } from "../../extensions/subagents/usage.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

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
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
		git("init", "-q");
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
