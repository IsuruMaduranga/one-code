import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager, type ToolCallEventResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookBridge } from "../../extensions/hooks/subagent-bridge.ts";
import { openChildSession } from "../../extensions/lib/agent-loader.ts";
import { SubagentRuntime } from "../../extensions/subagents/runner.ts";
import { registerWorktreeIsolation, releaseWorktreeIsolation } from "../../extensions/lib/worktree-isolation.ts";

describe("child hook and permission order", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hooks-child-order-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "config"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["Agent", "SendMessage"])("runs the parent's hooks for a child's %s call even though permission autoallows it", async (toolName) => {
		let decision: ToolCallEventResult | undefined;
		const hooks: HookBridge = { preToolUse: async () => ({ block: { reason: "no nested work" } }), postToolUse: async () => ({}) };
		const permission = vi.fn(async () => undefined);
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
			expect(this.getToolDefinition(toolName)).toBeDefined();
			decision = await this.extensionRunner!.emitToolCall({ type: "tool_call", toolCallId: "nested", toolName, input: {} });
		});
		const agentTool: ToolDefinition = { name: "Agent", label: "Agent", description: "Spawn a child", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };
		const runtime = await SubagentRuntime.create(cwd, () => [], () => permission, () => hooks);
		await runtime.run({ cwd, task: "do work", extraTools: [agentTool], onProgress: () => {} }).result;
		expect(decision).toEqual({ block: true, reason: "PreToolUse hook: no nested work" });
		expect(permission).not.toHaveBeenCalled();
	});

	it("stops at a child's hook denial before asking the permission bridge", async () => {
		const permission = vi.fn(async () => undefined);
		const hooks: HookBridge = { preToolUse: async () => ({ block: { reason: "child hook denied" } }), postToolUse: async () => ({}) };
		const session = await openChildSession({
			loader: { cwd, agentDir, noContextFiles: true, getHookBridge: () => hooks, getPermissionBridge: () => permission },
			session: { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		});
		try {
			const outcome = await session.extensionRunner!.emitToolCall({ type: "tool_call", toolCallId: "child-1", toolName: "bash", input: { command: "echo original" } });
			expect(outcome).toEqual({ block: true, reason: "PreToolUse hook: child hook denied" });
			expect(permission).not.toHaveBeenCalled();
		} finally {
			session.dispose();
		}
	});

	it("passes the final hook-rewritten input to the parent's permission bridge", async () => {
		const permission = vi.fn(async () => ({ block: true as const, reason: "rewritten command denied" }));
		const hooks: HookBridge = { preToolUse: async () => ({ updatedInput: { command: "echo rewritten" } }), postToolUse: async () => ({}) };
		const session = await openChildSession({
			loader: { cwd, agentDir, noContextFiles: true, getHookBridge: () => hooks, getPermissionBridge: () => permission },
			session: { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		});
		try {
			const input = { command: "echo original" };
			const outcome = await session.extensionRunner!.emitToolCall({ type: "tool_call", toolCallId: "child-2", toolName: "bash", input });
			expect(outcome).toEqual({ block: true, reason: "rewritten command denied" });
			expect(permission).toHaveBeenCalledWith(expect.objectContaining({ toolName: "bash", input: { command: "echo rewritten" }, cwd }));
			expect(input.command).toBe("echo rewritten");
		} finally {
			session.dispose();
		}
	});

	it("checks hook-rewritten paths with the child's worktree isolation guard", async () => {
		const worktree = join(root, "worktree");
		mkdirSync(worktree);
		registerWorktreeIsolation(worktree, cwd);
		const permission = vi.fn(async () => undefined);
		const hooks: HookBridge = { preToolUse: async () => ({ updatedInput: { path: join(cwd, "shared.txt") } }), postToolUse: async () => ({}) };
		const session = await openChildSession({
			loader: { cwd, agentDir, noContextFiles: true, getHookBridge: () => hooks, getPermissionBridge: () => permission },
			session: { cwd: worktree, agentDir, sessionManager: SessionManager.inMemory(worktree) },
		});
		try {
			const outcome = await session.extensionRunner!.emitToolCall({ type: "tool_call", toolCallId: "child-3", toolName: "write", input: { path: "own.txt", content: "text" } });
			expect(outcome?.block).toBe(true);
			expect(outcome?.reason).toContain("Refusing the write");
			expect(permission).not.toHaveBeenCalled();
		} finally {
			session.dispose();
			releaseWorktreeIsolation(worktree);
		}
	});
});
