/**
 * Project hooks with One Code's source provider on (Claude Code's
 * `.claude/settings.json`): discovery and consent stay at the parent
 * checkout while the hook runs in the entered worktree. The base's worktree
 * hook cwd: test/unit/hooks-worktree.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
import { shellQuote } from "../../extensions/lib/shell-quote.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { createFakeCtx, createFakePi, type FakePi } from "../../test/unit/helpers/fake-pi.ts";
import { envName } from "../../extensions/lib/brand.mjs";

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
	vi.stubEnv(envName("STATE_DIR"), join(root, "state"));
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

/** Hooks in the primary user settings file of the profile in force (user scope: no consent prompt). */
const seen = (): HookObservation[] => readFileSync(observations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const enter = () => fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: project });

describe("worktree hook cwd with Claude Code's project settings", () => {
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
});
