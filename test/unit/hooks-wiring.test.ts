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
import hooksExtension from "../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
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

		const input: Record<string, unknown> = { command: "echo original" };
		const result = await fake.fireOne<{ block?: boolean } | undefined>(
			"tool_call",
			{ toolName: "bash", toolCallId: "t1", input },
			ctx(),
		);
		expect(result).toBeUndefined();
		// updatedInput is applied in place, so downstream handlers see it too.
		expect(input.command).toBe("echo replaced");

		const contextMessage = fake.sentMessages.find((m) => m.message.customType === "one-code:hook-context");
		expect(contextMessage).toBeDefined();
		expect(contextMessage!.message.content as string).toContain("extra context from hook A");
		expect(contextMessage!.options).toMatchObject({ deliverAs: "steer" });
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
