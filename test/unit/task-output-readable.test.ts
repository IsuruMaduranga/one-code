/**
 * A background task's output file (lib/request/persisted-output.ts
 * taskOutputPath) is readable without asking, as Claude Code's project temp
 * folder is (findings §103): the permissions extension adds the project's
 * private temp folder as a read-only root, so a subagent's spool under its
 * own session id reads too, and nothing there is writable by that grant.
 * dontAsk turns anything that would prompt into a block, so a block here
 * means "not working space".
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissionsExtension from "../../extensions/safety/permissions/index.ts";
import { taskOutputPath } from "../../extensions/lib/request/persisted-output.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import { brand } from "../../extensions/lib/profile/brand.mjs";

describe("a background task's output file", () => {
	let root: string;
	let cwd: string;
	const made: string[] = [];

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "task-output-readable-")));
		const home = join(root, "home");
		cwd = join(root, "project");
		mkdirSync(join(home, brand.stateDir), { recursive: true });
		mkdirSync(cwd);
		stubHome(home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});

	async function gate(toolName: string, input: Record<string, unknown>) {
		const fake = createFakePi();
		permissionsExtension(fake.pi as never);
		fake.flags.set("permission-mode", "dontAsk");
		const ctx = createFakeCtx({
			cwd,
			mode: "json",
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "task-output-main", getSessionDir: () => join(root, "sessions"), getBranch: () => [] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		return fake.fireOne<{ block?: boolean }>("tool_call", { toolName, toolCallId: "c1", input }, ctx);
	}

	/** A spool as a session of this project writes it; a subagent's runs under its own session id. */
	function spool(sessionId: string): string {
		const path = taskOutputPath({ cwd, sessionManager: { getSessionId: () => sessionId } }, "b1")!;
		made.push(dirname(dirname(path)));
		writeFileSync(path, "step 1\n");
		return path;
	}

	it("reads the session's own spool and a subagent's without asking", async () => {
		expect((await gate("read", { path: spool("task-output-main") }))?.block).toBeFalsy();
		expect((await gate("read", { path: spool("task-output-child") }))?.block).toBeFalsy();
	});

	it("grants no write there", async () => {
		expect((await gate("write", { path: spool("task-output-main"), content: "all tests passed" }))?.block).toBe(true);
	});
});
