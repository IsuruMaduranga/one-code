import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
import { type HookBridge, SUBAGENT_HOOK_CHANNEL } from "../../extensions/hooks/subagent-bridge.ts";
import { hashProjectHooks, persistApproval, resetTrustSessionState } from "../../extensions/hooks/trust.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const state = vi.hoisted(() => ({ home: `/nonexistent/one-code-child-hooks-${Math.random().toString(36).slice(2)}` }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.home, default: { ...actualDefault, homedir: () => state.home } };
});

describe("child hooks in a worktree", () => {
	let root: string;
	let parent: string;
	let worktree: string;
	let config: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "hooks-child-worktree-")));
		parent = join(root, "parent");
		worktree = join(root, "worktree");
		config = join(root, "config");
		for (const dir of [parent, worktree, config]) mkdirSync(dir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", config);
		vi.stubEnv("ONECODE_STATE_DIR", join(root, "state"));
		resetHookSettingsCache();
		resetTrustSessionState();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetTrustSessionState();
		rmSync(root, { recursive: true, force: true });
	});

	function script(name: string, body: string): string {
		const path = join(root, `${name}.cjs`);
		writeFileSync(path, body);
		return `"${process.execPath}" "${path}"`;
	}

	async function bridge(): Promise<HookBridge> {
		const fake = createFakePi();
		let result: HookBridge | undefined;
		fake.events.on(SUBAGENT_HOOK_CHANNEL, (data) => {
			result = (data as { bridge: HookBridge }).bridge;
		});
		hooksExtension(fake.pi as never);
		await fake.fireOne("session_start", { reason: "startup" }, createFakeCtx({ cwd: parent }));
		return result!;
	}

	it("runs PreToolUse in the child's cwd while preserving the project root and child transcript", async () => {
		const record = join(root, "seen.json");
		const command = script("record", `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), project: process.env.CLAUDE_PROJECT_DIR, payload: JSON.parse(input) })));
`);
		writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }));
		const hooks = await bridge();
		const transcript = join(root, "child.jsonl");
		await hooks.preToolUse({ toolName: "bash", input: { command: "pwd" }, cwd: worktree, sessionId: "child", transcriptPath: transcript });
		const seen = JSON.parse(readFileSync(record, "utf8"));
		expect(seen).toMatchObject({ cwd: worktree, project: parent, payload: { cwd: worktree, transcript_path: transcript, agent_id: "child" } });
	});

	it("formats the child's relative file without modifying the parent checkout", async () => {
		writeFileSync(join(parent, "file.txt"), "parent contents\n");
		writeFileSync(join(worktree, "file.txt"), "child contents\n");
		const command = script("format", `process.stdin.resume(); require("node:fs").writeFileSync("file.txt", "formatted child\\n");`);
		writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command }] }] } }));
		const hooks = await bridge();
		const outcome = await hooks.postToolUse({ toolName: "write", input: { path: "file.txt", content: "child contents\n" }, cwd: worktree, sessionId: "child", content: [], isError: false });
		expect(readFileSync(join(parent, "file.txt"), "utf8")).toBe("parent contents\n");
		expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("formatted child\n");
		expect(outcome.additionalContext).toContain(`PostToolUse hook modified ${join(worktree, "file.txt")}`);
	});

	it("does not start a hook for an already-aborted child turn", async () => {
		const record = join(root, "aborted-hook-ran.txt");
		const command = script("aborted", `process.stdin.resume(); require("node:fs").writeFileSync(${JSON.stringify(record)}, "ran");`);
		writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }));
		const hooks = await bridge();
		const controller = new AbortController();
		controller.abort();
		await hooks.preToolUse({ toolName: "bash", input: { command: "pwd" }, cwd: worktree, sessionId: "child", signal: controller.signal });
		expect(existsSync(record)).toBe(false);
	});

	it("keeps the parent's approved project hook settings when the child cwd differs", async () => {
		const record = join(root, "project-cwd.txt");
		const command = script("project-hook", `process.stdin.resume(); require("node:fs").writeFileSync(${JSON.stringify(record)}, process.cwd());`);
		const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command }] }] };
		mkdirSync(join(parent, ".claude"));
		const path = join(parent, ".claude", "settings.json");
		writeFileSync(path, JSON.stringify({ hooks }));
		persistApproval(parent, hashProjectHooks([{ scope: "project", path, config: hooks }]));
		const childHooks = await bridge();
		await childHooks.preToolUse({ toolName: "bash", input: { command: "pwd" }, cwd: worktree, sessionId: "child" });
		expect(readFileSync(record, "utf8")).toBe(worktree);
	});
});
