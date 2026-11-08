/**
 * Folders and hook scripts for the tests of hooks that run in a worktree
 * (hooks-worktree, hooks-child-worktree and their One Code siblings): a
 * checkout, a worktree beside it and a config folder under one temp root, and
 * node scripts a settings file can name as a hook command.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import hooksExtension from "../../../extensions/hooks/index.ts";
import { resetHookSettingsCache } from "../../../extensions/hooks/settings.ts";
import { type HookBridge, SUBAGENT_HOOK_CHANNEL } from "../../../extensions/hooks/subagent-bridge.ts";
import { envName } from "../../../extensions/lib/brand.mjs";
import { shellQuote } from "../../../extensions/lib/shell-quote.ts";
import { createFakeCtx, createFakePi } from "./fake-pi.ts";

export interface HookWorktreeDirs {
	/** The temp root holding everything; remove it after the test. */
	root: string;
	/** The checkout the session started in. */
	project: string;
	worktree: string;
}

/**
 * Makes a checkout, a worktree and a config folder under a fresh temp root,
 * points `CLAUDE_CONFIG_DIR` and the product's state folder into it, and
 * clears the hook settings cache. Undo the env with `vi.unstubAllEnvs()`.
 */
export function makeHookWorktreeDirs(prefix: string): HookWorktreeDirs {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
	const project = join(root, "project");
	const worktree = join(root, "worktree");
	const config = join(root, "config");
	for (const dir of [project, worktree, config]) mkdirSync(dir);
	vi.stubEnv("CLAUDE_CONFIG_DIR", config);
	vi.stubEnv(envName("STATE_DIR"), join(root, "state"));
	resetHookSettingsCache();
	return { root, project, worktree };
}

/** Writes `<root>/<name>.cjs` and returns the hook command that runs it with this node. */
export function writeHookScript(root: string, name: string, body: string): string {
	const path = join(root, `${name}.cjs`);
	writeFileSync(path, body);
	return `${shellQuote(process.execPath)} ${shellQuote(path)}`;
}

/** Where one run of the observer hook ran, and the payload it read. */
export interface HookObservation {
	cwd: string;
	projectDir: string;
	payload: { cwd: string; hook_event_name: string; agent_id?: string };
}

/**
 * Writes the observer hook under `root`: each run appends its cwd,
 * `CLAUDE_PROJECT_DIR` and payload to `observations`, and a PostToolUse run
 * also rewrites `formatted.txt` in its cwd, as a formatter would.
 */
export function writeObserverHook(root: string): { command: string; observations: string } {
	const observations = join(root, "observations.jsonl");
	const command = writeHookScript(
		root,
		"hook",
		`const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({cwd: process.cwd(), projectDir: process.env.CLAUDE_PROJECT_DIR, payload}) + "\\n");
if (payload.hook_event_name === "PostToolUse") fs.writeFileSync("formatted.txt", "formatted by hook\\n");
`,
	);
	return { command, observations };
}

/** The observer hook's runs, in order. */
export function readObservations(observations: string): HookObservation[] {
	return readFileSync(observations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

/** The hook bridge a child session uses, from a hooks extension started in `cwd`. */
export async function childHookBridge(cwd: string): Promise<HookBridge> {
	const fake = createFakePi();
	let bridge: HookBridge | undefined;
	fake.events.on(SUBAGENT_HOOK_CHANNEL, (data) => {
		bridge = (data as { bridge: HookBridge }).bridge;
	});
	hooksExtension(fake.pi as never);
	await fake.fireOne("session_start", { reason: "startup" }, createFakeCtx({ cwd }));
	return bridge!;
}
