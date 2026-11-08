/**
 * A child session's hooks with One Code's source provider on: a project
 * hook in Claude Code's `.claude/settings.json`, approved in the parent, runs
 * for a child in a worktree, in the child's cwd. The base's child hooks:
 * test/unit/hooks-child-worktree.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
import { type HookBridge, SUBAGENT_HOOK_CHANNEL } from "../../extensions/hooks/subagent-bridge.ts";
import { hashProjectHooks, persistApproval, resetTrustSessionState } from "../../extensions/hooks/trust.ts";
import { envName } from "../../extensions/lib/brand.mjs";
import { createFakeCtx, createFakePi } from "../../test/unit/helpers/fake-pi.ts";

const state = vi.hoisted(() => ({ home: `/nonexistent/one-code-child-hooks-${Math.random().toString(36).slice(2)}` }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.home, default: { ...actualDefault, homedir: () => state.home } };
});

describe("child hooks in a worktree, with Claude Code's project settings", () => {
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
		vi.stubEnv(envName("STATE_DIR"), join(root, "state"));
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
