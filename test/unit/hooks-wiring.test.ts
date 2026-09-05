/**
 * hooks/index.ts wiring (T15b): the PreToolUse/PostToolUse dispatch merge
 * (block + updatedInput + additionalContext from several hooks combined) and
 * the Stop latch — Stop must fire once per SETTLED turn, not once per
 * internal run (a turn can retry/auto-compact and produce several agent_end
 * events before it settles — extensions/lib/interrupt.ts).
 *
 * Hooks are real shell commands run through the real executor (by design —
 * see executor.ts's own header), so this uses actual (trivial, instant)
 * `/bin/sh` scripts under a temp dir rather than mocking the executor. User
 * scope only, so no project-hook consent prompt is involved (that flow is
 * hooks-trust.test.ts's job). `os.homedir()` is redirected to a nonexistent
 * path so plugin-hook discovery — which is not routed through the temp
 * CLAUDE_CONFIG_DIR — can never pick up whatever hook plugins happen to be
 * installed on the machine running this test.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension, { hookContextText } from "../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
import { type HookBridge, SUBAGENT_HOOK_CHANNEL } from "../../extensions/hooks/subagent-bridge.ts";
import { REMINDER_CHANNEL, wrapReminder } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const state = vi.hoisted(() => ({
	fakeHome: `/nonexistent/one-code-test-hooks-wiring-fake-home-${Math.random().toString(36).slice(2)}`,
}));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.fakeHome, default: { ...actualDefault, homedir: () => state.fakeHome } };
});

describe("hooks wiring", () => {
	let root: string;
	let claudeDir: string;
	let projectDir: string;
	let fake: FakePi;

	const script = (name: string, body: string) => {
		const path = join(root, name);
		writeFileSync(path, body);
		return `sh "${path}"`;
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hooks-wiring-"));
		claudeDir = join(root, "claude-config");
		projectDir = join(root, "project");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
		resetHookSettingsCache();
		fake = createFakePi();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const writeUserHooks = (hooks: Record<string, unknown>) => {
		writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks }));
	};

	const mount = () => hooksExtension(fake.pi as never);
	const ctx = () => createFakeCtx({ cwd: projectDir });

	it("merges several non-blocking PreToolUse hooks: one rewrites input, another adds context", async () => {
		const hookA = script("hook-a.sh", `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"additionalContext":"extra context from hook A"}}'\n`);
		const hookB = script("hook-b.sh", `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"updatedInput":{"command":"echo replaced"}}}'\n`);
		writeUserHooks({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookA }, { type: "command", command: hookB }] }] });
		mount();
		const reminders: Array<{ text: string; placement?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { text: string; placement?: string }));

		const input: Record<string, unknown> = { command: "echo original" };
		const result = await fake.fireOne<{ block?: boolean } | undefined>(
			"tool_call",
			{ toolName: "bash", toolCallId: "t1", input },
			ctx(),
		);
		expect(result).toBeUndefined();
		// updatedInput is applied in place, so downstream handlers see it too.
		expect(input.command).toBe("echo replaced");

		// PreToolUse context is a one-shot on the reminder channel — it lands inside
		// this call's tool result, in Claude Code's hook_additional_context wording,
		// at no extra turn (STEERING-REVIEW-2026-09-05 M6). Never a steer of its own.
		expect(reminders).toHaveLength(1);
		expect(reminders[0].text).toBe(hookContextText("PreToolUse", "extra context from hook A"));
		expect(reminders[0].placement).toBeUndefined();
		expect(fake.sentMessages).toHaveLength(0);
	});

	it("PostToolUse context is appended to the result as a system-reminder in CC's wording", async () => {
		const hookPost = script("hook-post-ctx.sh", `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"additionalContext":"lint clean"}}'\n`);
		writeUserHooks({ PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookPost }] }] });
		mount();
		const result = await fake.fireOne<{ content: Array<{ type: string; text: string }> }>(
			"tool_result",
			{ toolName: "bash", toolCallId: "t3", input: {}, content: [{ type: "text", text: "original" }], isError: false },
			ctx(),
		);
		expect(result?.content).toEqual([
			{ type: "text", text: "original" },
			{ type: "text", text: wrapReminder(hookContextText("PostToolUse", "lint clean")) },
		]);
		expect(fake.sentMessages).toHaveLength(0);
	});

	it("UserPromptSubmit context rides the prompt's own turn, AFTER the prompt (before_agent_start message), not as an idle message before it", async () => {
		const hookPrompt = script("hook-prompt.sh", `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"additionalContext":"today is a holiday"}}'\n`);
		writeUserHooks({ UserPromptSubmit: [{ hooks: [{ type: "command", command: hookPrompt }] }] });
		mount();
		await fake.fireOne("input", { source: "interactive", text: "hello" }, ctx());
		// Nothing is sent on its own: pi would have appended an idle custom message
		// BEFORE the user message it is about to add.
		expect(fake.sentMessages).toHaveLength(0);
		const result = await fake.fireOne<{ message?: { customType: string; content: string; display: boolean } }>("before_agent_start", { prompt: "hello" }, ctx());
		expect(result?.message).toEqual({
			customType: "one-code:hook-context",
			content: wrapReminder(hookContextText("UserPromptSubmit", "today is a holiday")),
			display: false,
		});
		// Delivered once.
		const again = await fake.fireOne<{ message?: unknown }>("before_agent_start", { prompt: "next" }, ctx());
		expect(again).toBeUndefined();
	});

	it("publishes a hook bridge at session start that runs the user's tool hooks for a child's calls, naming the agent", async () => {
		const seen = join(root, "child-stdin.json");
		const hookA = script(
			"hook-child.sh",
			`#!/bin/sh\ncat > "${seen}"\nif grep -q '"agent_id"' "${seen}"; then echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no rm in children"}}'; fi\n`,
		);
		writeUserHooks({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookA }] }] });
		mount();
		let bridge: HookBridge | undefined;
		fake.events.on(SUBAGENT_HOOK_CHANNEL, (data) => {
			bridge = (data as { bridge: HookBridge }).bridge;
		});
		await fake.fireOne("session_start", { reason: "startup" }, ctx());
		expect(bridge).toBeDefined();

		const outcome = await bridge!.preToolUse({
			toolName: "bash",
			input: { command: "rm -rf build" },
			cwd: join(projectDir, "wt"),
			sessionId: "child-1",
			agentType: "explore",
		});
		expect(outcome.block?.reason).toBe("no rm in children");
		// The hook read a Claude Code payload naming the child (agent_id present,
		// agent_type = the agent), with the child's cwd and session id.
		const stdin = JSON.parse(readFileSync(seen, "utf-8"));
		expect(stdin).toMatchObject({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "rm -rf build" },
			session_id: "child-1",
			agent_id: "child-1",
			agent_type: "explore",
			cwd: join(projectDir, "wt"),
		});
	});

	it("the bridge translates a child's updatedInput back to native names and frames its context like the parent's", async () => {
		const hookB = script("hook-child-b.sh", `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"updatedInput":{"file_path":"/tmp/other.txt"},"additionalContext":"careful"}}'\n`);
		writeUserHooks({ PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: hookB }] }] });
		mount();
		let bridge: HookBridge | undefined;
		fake.events.on(SUBAGENT_HOOK_CHANNEL, (data) => {
			bridge = (data as { bridge: HookBridge }).bridge;
		});
		await fake.fireOne("session_start", { reason: "startup" }, ctx());
		const pre = await bridge!.preToolUse({ toolName: "read", input: { path: "/tmp/a.txt" }, cwd: projectDir, sessionId: "c" });
		expect(pre.block).toBeUndefined();
		expect(pre.updatedInput).toEqual({ path: "/tmp/other.txt" });
		expect(pre.additionalContext).toBe(hookContextText("PreToolUse", "careful"));

		const post = await bridge!.postToolUse({ toolName: "read", input: {}, cwd: projectDir, sessionId: "c", content: [], isError: false });
		// No PostToolUse hooks configured: nothing to apply.
		expect(post).toEqual({ block: undefined, updatedToolResult: undefined, additionalContext: undefined });
	});

	it("a PreToolUse hook blocks the tool call, quoting the hook's reason", async () => {
		const hookBlock = script("hook-block.sh", `#!/bin/sh\ncat >/dev/null\necho '{"decision":"block","reason":"blocked by policy"}'\n`);
		writeUserHooks({ PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: hookBlock }] }] });
		mount();

		const result = await fake.fireOne<{ block?: boolean; reason?: string }>(
			"tool_call",
			{ toolName: "edit", toolCallId: "t2", input: { path: "/x.ts" } },
			ctx(),
		);
		expect(result).toEqual({ block: true, reason: "PreToolUse hook: blocked by policy" });
	});

	it("a PostToolUse hook replaces the tool result content", async () => {
		const hookPost = script("hook-post.sh", `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"updatedToolResult":"modified result"}}'\n`);
		writeUserHooks({ PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookPost }] }] });
		mount();

		const result = await fake.fireOne<{ content: Array<{ type: string; text: string }>; isError: boolean }>(
			"tool_result",
			{ toolName: "bash", toolCallId: "t3", input: {}, content: [{ type: "text", text: "original" }], isError: false },
			ctx(),
		);
		expect(result).toEqual({ content: [{ type: "text", text: "modified result" }], isError: false });
	});

	it("Stop fires once per settled turn, not once per retried run within the turn, and is skipped when the turn ended in error/abort", async () => {
		const counter = join(root, "stop-count.txt");
		vi.stubEnv("STOP_COUNTER", counter);
		const hookStop = script("hook-stop.sh", `#!/bin/sh\ncat >/dev/null\necho hit >> "$STOP_COUNTER"\n`);
		writeUserHooks({ Stop: [{ hooks: [{ type: "command", command: hookStop } as const] }] });
		mount();

		const countHits = () => {
			try {
				return readFileSync(counter, "utf-8").split("\n").filter(Boolean).length;
			} catch {
				return 0;
			}
		};

		// One turn: two internal runs (e.g. a retried run) both ending "ok",
		// then ONE agent_settled — Stop must run exactly once.
		await fake.fireOne("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] }, ctx());
		await fake.fireOne("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx());
		await fake.fireOne("agent_settled", {}, ctx());
		expect(countHits()).toBe(1);

		// A second agent_settled with no new agent_end in between (latch empty)
		// must not fire Stop again.
		await fake.fireOne("agent_settled", {}, ctx());
		expect(countHits()).toBe(1);

		// A turn that ended aborted or on a provider error must skip Stop entirely.
		await fake.fireOne("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx());
		await fake.fireOne("agent_settled", {}, ctx());
		expect(countHits()).toBe(1);

		await fake.fireOne("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, ctx());
		await fake.fireOne("agent_settled", {}, ctx());
		expect(countHits()).toBe(1);

		// A genuinely new ok-ending run does fire it again.
		await fake.fireOne("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx());
		await fake.fireOne("agent_settled", {}, ctx());
		expect(countHits()).toBe(2);
	});
});
