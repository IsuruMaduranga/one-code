/** Regression probes for independent memory loading and historical context snapshots. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { contextStackOnBranch } from "../../extensions/lib/context-stack.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

// Intercept a FIFO read rather than opening it: an unguarded synchronous open
// would hang the test worker and the harness event loop indefinitely.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const originalReadFile = vi.mocked(readFileSync).getMockImplementation()!;
const SECRET = "CLAUDE-ONLY MEMORY MUST NOT ENTER INDEPENDENT CONTEXT";
const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const branchOf = (fake: ReturnType<typeof createFakePi>) => fake.appendedEntries.map((entry) => ({ type: "custom", ...structuredClone(entry) }));
let root: string;
let home: string;
let cwd: string;
let index: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "memory-context-audit-"));
	home = join(root, "home");
	cwd = join(root, "project");
	mkdirSync(home);
	mkdirSync(cwd);
	stubHome(home);
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
	resetConfigModeForTest("independent");
	index = join(projectMemoryDir(cwd, home), "MEMORY.md");
	mkdirSync(dirname(index), { recursive: true });
	vi.mocked(readFileSync).mockClear();
});
afterEach(() => {
	vi.mocked(readFileSync).mockReset();
	vi.mocked(readFileSync).mockImplementation(originalReadFile);
	vi.unstubAllEnvs();
	resetConfigModeForTest();
	rmSync(root, { recursive: true, force: true });
});

function claudeMemory(base = join(home, ".claude")): string {
	const target = join(base, "projects", "private", "memory", "MEMORY.md");
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${SECRET}\n`);
	return target;
}

async function open(branch: unknown[] = []) {
	const fake = createFakePi();
	systemReminderExtension(fake.pi as never);
	claudeContextExtension(fake.pi as never);
	const ctx = createFakeCtx({ cwd, sessionManager: { getBranch: () => [...branch, ...branchOf(fake)] } });
	await fake.fire("session_start", { reason: branch.length ? "resume" : "startup" }, ctx);
	const turn = async () => {
		await fake.fire("before_agent_start", {}, ctx);
		await fake.fire("turn_start", {}, ctx);
	};
	const request = async (messages: unknown[]) => (await fake.fireOne<{ messages: unknown[] }>("context", { messages }, ctx))!.messages;
	return { fake, ctx, turn, request };
}

describe("independent memory context audit", () => {
	it("does not load a MEMORY.md symlink into ~/.claude on startup", async () => {
		symlinkSync(claudeMemory(), index);
		const run = await open();
		await run.turn();
		expect(JSON.stringify(await run.request([user("first", 1)]))).not.toContain(SECRET);
	});

	it("does not load a memory-directory symlink into ~/.claude on startup", async () => {
		const target = claudeMemory();
		rmSync(dirname(index), { recursive: true });
		symlinkSync(dirname(target), dirname(index), "dir");
		const run = await open();
		await run.turn();
		expect(JSON.stringify(await run.request([user("first", 1)]))).not.toContain(SECRET);
	});

	it("does not load an index alias into relocated CLAUDE_CONFIG_DIR", async () => {
		const relocated = join(home, "relocated-claude-config");
		vi.stubEnv("CLAUDE_CONFIG_DIR", relocated);
		symlinkSync(claudeMemory(relocated), index);
		const run = await open();
		await run.turn();
		expect(JSON.stringify(await run.request([user("first", 1)]))).not.toContain(SECRET);
	});

	it("does not treat an excluded Claude memory alias as a resume-time memory change", async () => {
		const first = await open();
		await first.turn();
		await first.request([user("first", 1)]);
		const branch = branchOf(first.fake);
		symlinkSync(claudeMemory(), index);
		const resumed = await open(branch);
		await resumed.turn();
		expect(JSON.stringify(await resumed.request([user("first", 1), user("resume", 2)]))).not.toContain("the memory index changed");
	});

	it("does not persist excluded Claude memory in a refreshed compaction snapshot", async () => {
		writeFileSync(index, "INDEPENDENT MEMORY\n");
		const run = await open();
		await run.turn();
		await run.request([user("first", 1)]);
		rmSync(index);
		symlinkSync(claudeMemory(), index);
		await run.fake.fire("session_compact", { reason: "manual" }, run.ctx);
		const summary = [{ role: "compactionSummary", summary: "summary", timestamp: 2 }];
		expect.soft(JSON.stringify(await run.request(summary))).not.toContain(SECRET);
		expect.soft(JSON.stringify(contextStackOnBranch(branchOf(run.fake)))).not.toContain(SECRET);
	});

	it.skipIf(process.platform === "win32")("does not attempt a blocking read of a FIFO index", async () => {
		execFileSync("mkfifo", [index]);
		const original = vi.mocked(readFileSync).getMockImplementation()!;
		const attempts: unknown[] = [];
		vi.mocked(readFileSync).mockImplementation(((...args: Parameters<typeof readFileSync>) => {
			if (String(args[0]) === index) {
				attempts.push(args[0]);
				return "";
			}
			return original(...args);
		}) as typeof readFileSync);
		await open();
		expect(attempts).toEqual([]);
	});

	it("does not load a binary index containing NUL bytes", async () => {
		writeFileSync(index, Buffer.from("BINARY MEMORY CONTENT\0not markdown\n"));
		const run = await open();
		await run.turn();
		expect(JSON.stringify(await run.request([user("first", 1)]))).not.toContain("BINARY MEMORY CONTENT");
	});

	it("loads regular independent memory through an allowed symlink", async () => {
		const target = join(root, "shared-memory.md");
		writeFileSync(target, "INDEPENDENT MEMORY CONTENT\n");
		symlinkSync(target, index);
		const run = await open();
		await run.turn();
		expect(JSON.stringify(await run.request([user("first", 1)]))).toContain("INDEPENDENT MEMORY CONTENT");
	});

	it("continues loading Claude memory in compatible mode", async () => {
		resetConfigModeForTest("claude-compatible");
		const compatibleIndex = join(projectMemoryDir(cwd, home), "MEMORY.md");
		mkdirSync(dirname(compatibleIndex), { recursive: true });
		writeFileSync(compatibleIndex, `${SECRET}\n`);
		const run = await open();
		await run.turn();
		expect(JSON.stringify(await run.request([user("first", 1)]))).toContain(SECRET);
	});
});
