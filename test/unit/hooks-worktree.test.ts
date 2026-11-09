/**
 * Hook execution follows the calling worktree without moving config to it.
 * Consent for project hooks (One Code's source provider reads Claude Code's
 * project settings): profile/test/hooks-worktree-project.test.ts.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/safety/hooks/index.ts";
import { SUBAGENT_HOOK_CHANNEL, type HookBridge } from "../../extensions/lib/agents/hook-bridge.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/agents/worktree-channel.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { makeHookWorktreeDirs, readObservations, writeObserverHook } from "./helpers/hook-worktree.ts";
import { writeUserSettings } from "./helpers/settings-files.ts";

const state = vi.hoisted(() => ({ home: `/nonexistent/one-code-hooks-worktree-${Math.random().toString(36).slice(2)}` }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => state.home, default: { ...actual, homedir: () => state.home } };
});

let root: string;
let project: string;
let worktree: string;
let observations: string;
let command: string;
let fake: FakePi;

beforeEach(() => {
	({ root, project, worktree } = makeHookWorktreeDirs("hooks-worktree-"));
	({ command, observations } = writeObserverHook(root));
	fake = createFakePi();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

/** Hooks in the primary user settings file of the profile in force (user scope: no consent prompt). */
const writeHooks = (events: string[]) =>
	writeUserSettings(project, homedir(), { hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command }] }]])) });
/** The reminder after a PostToolUse hook changed the file a call wrote. */
const changedByHook = (path: string) => requireText("hooks").fileChangedByHook({ path });
const seen = () => readObservations(observations);
const enter = () => fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: project });
const toolCall = (id: string) => fake.fire("tool_call", { toolName: "bash", toolCallId: id, input: { command: "pwd" } }, createFakeCtx({ cwd: project }));

describe("worktree hook cwd", () => {
	it("runs main-session hooks in the entered worktree, then returns to the original directory on exit", async () => {
		writeHooks(["PreToolUse", "PostToolUse"]);
		writeFileSync(join(project, "formatted.txt"), "original checkout\n");
		writeFileSync(join(worktree, "formatted.txt"), "model edit\n");
		hooksExtension(fake.pi as never);
		enter();
		await toolCall("entered");
		const [post] = await fake.fire<{ content: Array<{ text: string }> }>("tool_result", { toolName: "write", toolCallId: "written", input: { path: "formatted.txt" }, content: [], isError: false }, createFakeCtx({ cwd: project }));
		expect(post.content[0].text).toContain(changedByHook(join(worktree, "formatted.txt")));
		fake.events.emit(WORKTREE_CHANNEL, null);
		await toolCall("exited");
		expect(seen().map(({ cwd, projectDir, payload }) => [cwd, projectDir, payload.cwd])).toEqual([
			[worktree, project, worktree],
			[worktree, project, worktree],
			[project, project, project],
		]);
		expect(readFileSync(join(project, "formatted.txt"), "utf8")).toBe("original checkout\n");
		expect(readFileSync(join(worktree, "formatted.txt"), "utf8")).toBe("formatted by hook\n");
	});

	it("never falls back to running a hook in the original checkout when the worktree disappears", async () => {
		writeHooks(["PreToolUse"]);
		hooksExtension(fake.pi as never);
		enter();
		rmSync(worktree, { recursive: true });
		await toolCall("missing");
		expect(existsSync(observations)).toBe(false);
	});

	it("runs a child's PreToolUse and formatter hooks in the child's cwd, not the parent's", async () => {
		writeHooks(["PreToolUse", "PostToolUse"]);
		writeFileSync(join(project, "formatted.txt"), "original checkout\n");
		writeFileSync(join(worktree, "formatted.txt"), "child edit\n");
		hooksExtension(fake.pi as never);
		let bridge: HookBridge | undefined;
		fake.events.on(SUBAGENT_HOOK_CHANNEL, (data) => { bridge = (data as { bridge: HookBridge }).bridge; });
		await fake.fire("session_start", { reason: "startup" }, createFakeCtx({ cwd: project }));
		const call = { toolName: "write", input: { path: "formatted.txt" }, cwd: worktree, sessionId: "child" };
		await bridge!.preToolUse(call);
		const post = await bridge!.postToolUse({ ...call, content: [], isError: false });
		expect(post.additionalContext).toContain(changedByHook(join(worktree, "formatted.txt")));
		expect(seen().map(({ cwd, projectDir, payload }) => [cwd, projectDir, payload.cwd, payload.agent_id])).toEqual([
			[worktree, project, worktree, "child"],
			[worktree, project, worktree, "child"],
		]);
		expect(readFileSync(join(project, "formatted.txt"), "utf8")).toBe("original checkout\n");
		expect(readFileSync(join(worktree, "formatted.txt"), "utf8")).toBe("formatted by hook\n");
	});

	it("does not start a queued SessionStart hook after the session shuts down", async () => {
		writeHooks(["SessionStart"]);
		hooksExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: project });
		await fake.fire("session_start", { reason: "resume" }, ctx);
		await fake.fire("session_shutdown", { reason: "reload" }, ctx);
		await fake.fire("before_agent_start", { prompt: "unused" }, ctx);
		expect(existsSync(observations)).toBe(false);
	});

	it("uses the resumed worktree for SessionStart after later lifecycle handlers restore it", async () => {
		writeHooks(["SessionStart", "UserPromptSubmit"]);
		hooksExtension(fake.pi as never);
		// worktree loads after hooks and restores its persisted state here.
		(fake.pi.on as (event: string, handler: () => void) => void)("session_start", enter);
		const ctx = createFakeCtx({ cwd: project });
		await fake.fire("session_start", { reason: "resume" }, ctx);
		await fake.fire("input", { source: "interactive", text: "continue" }, ctx);
		expect(seen().map(({ cwd, payload }) => [payload.hook_event_name, cwd, payload.cwd])).toEqual([
			["SessionStart", worktree, worktree],
			["UserPromptSubmit", worktree, worktree],
		]);
	});
});
