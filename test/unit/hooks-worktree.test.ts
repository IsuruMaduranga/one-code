/** Hook execution follows the calling worktree without moving config or consent to it. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
import { SUBAGENT_HOOK_CHANNEL, type HookBridge } from "../../extensions/hooks/subagent-bridge.ts";
import { shellQuote } from "../../extensions/lib/shell-quote.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const state = vi.hoisted(() => ({ home: `/nonexistent/one-code-hooks-worktree-${Math.random().toString(36).slice(2)}` }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => state.home, default: { ...actual, homedir: () => state.home } };
});

interface HookObservation {
	cwd: string;
	projectDir: string;
	payload: { cwd: string; hook_event_name: string; agent_id?: string };
}

let root: string;
let project: string;
let worktree: string;
let config: string;
let observations: string;
let command: string;
let fake: FakePi;

beforeEach(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "hooks-worktree-")));
	project = join(root, "project");
	worktree = join(root, "worktree");
	config = join(root, "config");
	observations = join(root, "observations.jsonl");
	for (const dir of [project, worktree, config]) mkdirSync(dir);
	vi.stubEnv("CLAUDE_CONFIG_DIR", config);
	vi.stubEnv("ONECODE_STATE_DIR", join(root, "state"));
	resetHookSettingsCache();
	const script = join(root, "hook.cjs");
	writeFileSync(script, `const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({cwd: process.cwd(), projectDir: process.env.CLAUDE_PROJECT_DIR, payload}) + "\\n");
if (payload.hook_event_name === "PostToolUse") fs.writeFileSync("formatted.txt", "formatted by hook\\n");
`);
	command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
	fake = createFakePi();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

const writeHooks = (events: string[]) => writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command }] }]])) }));
const seen = (): HookObservation[] => readFileSync(observations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
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
		expect(post.content[0].text).toContain(join(worktree, "formatted.txt"));
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
		expect(post.additionalContext).toContain(join(worktree, "formatted.txt"));
		expect(seen().map(({ cwd, projectDir, payload }) => [cwd, projectDir, payload.cwd, payload.agent_id])).toEqual([
			[worktree, project, worktree, "child"],
			[worktree, project, worktree, "child"],
		]);
		expect(readFileSync(join(project, "formatted.txt"), "utf8")).toBe("original checkout\n");
		expect(readFileSync(join(worktree, "formatted.txt"), "utf8")).toBe("formatted by hook\n");
	});

	it("keeps project hook discovery and consent at the parent even when the worktree has different settings", async () => {
		for (const dir of [project, worktree]) mkdirSync(join(dir, ".claude"));
		writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }));
		writeFileSync(join(worktree, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }] } }));
		const confirm = vi.fn(async () => true);
		const ctx = createFakeCtx({ cwd: project, hasUI: true, ui: { confirm } });
		hooksExtension(fake.pi as never);
		enter();
		const [result] = await fake.fire("tool_call", { toolName: "bash", toolCallId: "project-hook", input: { command: "pwd" } }, ctx);
		expect(result).toBeUndefined();
		expect(confirm).toHaveBeenCalledOnce();
		expect(seen()).toHaveLength(1);
		expect(seen()[0]).toMatchObject({ cwd: worktree, projectDir: project, payload: { cwd: worktree } });
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

	it("reserves startup hook consent before yielding but captures cwd after worktree restoration", async () => {
		mkdirSync(join(project, ".claude"));
		writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }));
		const confirm = vi.fn(async () => true);
		const ctx = createFakeCtx({ cwd: project, hasUI: true, ui: { confirm } });
		hooksExtension(fake.pi as never);
		(fake.pi.on as (event: string, handler: () => void) => void)("session_start", enter);
		const starting = fake.fire("session_start", { reason: "resume" }, ctx);
		expect(confirm).toHaveBeenCalledOnce();
		await starting;
		await fake.fire("before_agent_start", { prompt: "continue" }, ctx);
		expect(seen()).toHaveLength(1);
		expect(seen()[0]).toMatchObject({ cwd: worktree, projectDir: project, payload: { cwd: worktree } });
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
