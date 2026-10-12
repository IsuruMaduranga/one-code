/** With auto-memory off, its folder is no harness working space: no write grant, no read-before-edit pass. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAutoMemoryForTest } from "../../extensions/lib/auto-memory.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

describe("auto-memory off", () => {
	let root: string;
	let home: string;
	let cwd: string;

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "auto-memory-off-")));
		home = join(root, "home");
		cwd = join(root, "project");
		mkdirSync(join(home, ".onecode"), { recursive: true });
		mkdirSync(cwd);
		stubHome(home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
		vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
		mkdirSync(projectMemoryDir(cwd, home), { recursive: true });
	});
	afterEach(() => {
		resetAutoMemoryForTest();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function writeIntoMemory(enabled: boolean) {
		resetAutoMemoryForTest(enabled);
		const fake = createFakePi();
		permissionsExtension(fake.pi as never);
		fake.flags.set("permission-mode", "dontAsk");
		const ctx = createFakeCtx({
			cwd,
			mode: "json",
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "memory-off", getSessionDir: () => join(root, "sessions"), getBranch: () => [] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const path = join(projectMemoryDir(cwd, home), "fact.md");
		return fake.fireOne<{ block?: boolean }>("tool_call", { toolName: "write", toolCallId: "w1", input: { path, content: "x" } }, ctx);
	}

	it("writes into the memory folder without asking while auto-memory is on", async () => {
		expect((await writeIntoMemory(true))?.block).toBeFalsy();
	});

	it("treats the memory folder as any outside path once auto-memory is off", async () => {
		expect((await writeIntoMemory(false))?.block).toBe(true);
	});
});
