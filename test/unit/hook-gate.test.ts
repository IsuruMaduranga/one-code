/**
 * lib/hook-gate.ts: the child half of the subagent hook bridge — a child's
 * tool_call/tool_result forwarded to the parent's hooks and the outcome applied
 * as the parent applies it to its own calls; fail-open without a bridge.
 */
import { describe, expect, it } from "vitest";
import type { ChildHookCall, ChildHookResult, HookBridge } from "../../extensions/hooks/subagent-bridge.ts";
import { hookGateFactory } from "../../extensions/lib/hook-gate.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

function mount(bridge: HookBridge | undefined, agentTypeOf?: (id: string | undefined) => string | undefined) {
	const fake = createFakePi();
	(hookGateFactory(() => bridge, { agentTypeOf }) as { factory: (pi: unknown) => void }).factory(fake.pi);
	const reminders: Array<{ text: string }> = [];
	fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { text: string }));
	return { fake, reminders };
}

const childCtx = () =>
	createFakeCtx({ cwd: "/work/tree", sessionManager: { getSessionId: () => "child-9", getSessionFile: () => "/sessions/child-9.jsonl", getBranch: () => [] } });

describe("hookGateFactory", () => {
	it("forwards a tool call with the child's identity and denies on a hook block", async () => {
		const calls: ChildHookCall[] = [];
		const bridge: HookBridge = {
			async preToolUse(call) {
				calls.push(call);
				return { block: { reason: "not in children" } };
			},
			async postToolUse() {
				return {};
			},
		};
		const { fake } = mount(bridge, (id) => (id === "child-9" ? "explore" : undefined));
		const result = await fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rm x" } }, childCtx());
		expect(result).toEqual({ block: true, reason: "PreToolUse hook: not in children" });
		expect(calls).toEqual([
			{ toolName: "bash", input: { command: "rm x" }, cwd: "/work/tree", sessionId: "child-9", transcriptPath: "/sessions/child-9.jsonl", agentType: "explore" },
		]);
	});

	it("applies updatedInput in place and queues context on the child's reminder channel", async () => {
		const bridge: HookBridge = {
			async preToolUse() {
				return { updatedInput: { command: "echo safe" }, additionalContext: "PreToolUse hook additional context: careful" };
			},
			async postToolUse() {
				return {};
			},
		};
		const { fake, reminders } = mount(bridge);
		const input: Record<string, unknown> = { command: "echo original" };
		const result = await fake.fireOne("tool_call", { toolName: "bash", toolCallId: "t1", input }, childCtx());
		expect(result).toBeUndefined();
		expect(input.command).toBe("echo safe");
		expect(reminders).toEqual([{ text: "PreToolUse hook additional context: careful" }]);
	});

	it("rewrites the tool result on PostToolUse: replacement, block reason, context", async () => {
		const seen: ChildHookResult[] = [];
		const bridge: HookBridge = {
			async preToolUse() {
				return {};
			},
			async postToolUse(result) {
				seen.push(result);
				return { block: { reason: "lint failed" }, updatedToolResult: "replaced", additionalContext: "<system-reminder>\nctx\n</system-reminder>" };
			},
		};
		const { fake } = mount(bridge);
		const result = await fake.fireOne<{ content: unknown[]; isError: boolean }>(
			"tool_result",
			{ toolName: "edit", toolCallId: "t2", input: { path: "a" }, content: [{ type: "text", text: "original" }], isError: false },
			childCtx(),
		);
		expect(result).toEqual({
			content: [
				{ type: "text", text: "PostToolUse hook: lint failed" },
				{ type: "text", text: "replaced" },
				{ type: "text", text: "<system-reminder>\nctx\n</system-reminder>" },
			],
			isError: false,
		});
		expect(seen[0]).toMatchObject({ toolName: "edit", content: [{ type: "text", text: "original" }], isError: false, sessionId: "child-9" });
	});

	it("passes through untouched when there is no bridge, when hooks say nothing, and when the bridge throws (fail open)", async () => {
		const { fake: none } = mount(undefined);
		expect(await none.fireOne("tool_call", { toolName: "bash", toolCallId: "t1", input: {} }, childCtx())).toBeUndefined();
		expect(await none.fireOne("tool_result", { toolName: "bash", toolCallId: "t1", input: {}, content: [], isError: false }, childCtx())).toBeUndefined();

		const silent: HookBridge = { preToolUse: async () => ({}), postToolUse: async () => ({}) };
		const { fake: quiet } = mount(silent);
		expect(await quiet.fireOne("tool_call", { toolName: "bash", toolCallId: "t1", input: {} }, childCtx())).toBeUndefined();
		expect(await quiet.fireOne("tool_result", { toolName: "bash", toolCallId: "t1", input: {}, content: [], isError: false }, childCtx())).toBeUndefined();

		const broken: HookBridge = {
			preToolUse: async () => {
				throw new Error("bus gone");
			},
			postToolUse: async () => {
				throw new Error("bus gone");
			},
		};
		const { fake: failing } = mount(broken);
		expect(await failing.fireOne("tool_call", { toolName: "bash", toolCallId: "t1", input: {} }, childCtx())).toBeUndefined();
		expect(await failing.fireOne("tool_result", { toolName: "bash", toolCallId: "t1", input: {}, content: [], isError: false }, childCtx())).toBeUndefined();
	});

	it("never runs hooks for runtime-injected tools", async () => {
		let called = 0;
		const bridge: HookBridge = {
			preToolUse: async () => {
				called++;
				return { block: { reason: "x" } };
			},
			postToolUse: async () => ({}),
		};
		const { fake } = mount(bridge);
		expect(await fake.fireOne("tool_call", { toolName: "structured_output", toolCallId: "t1", input: {} }, childCtx())).toBeUndefined();
		expect(called).toBe(0);
	});
});
