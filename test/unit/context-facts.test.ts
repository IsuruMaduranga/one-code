import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { contextFactsBaseline, resumeFactsNotice } from "../../extensions/lib/context-facts.ts";
import { contextStackOnBranch, type ContextStackSnapshot } from "../../extensions/lib/context-stack.ts";
import { GIT_SNAPSHOT_OWNER_CHANNEL } from "../../extensions/lib/git-status.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const branchOf = (fake: ReturnType<typeof createFakePi>) => JSON.parse(JSON.stringify(fake.appendedEntries.map((entry) => ({ type: "custom", ...entry }))));

describe("context fact comparisons", () => {
	it("reports only changed categories and sends nothing for identical visible facts", () => {
		const source = { contextFiles: [{ path: "/CLAUDE.md", content: "rules", descriptor: "rules" }], memoryIndex: { path: "/MEMORY.md", content: "memory" }, gitStatus: "git snapshot", atCompaction: false };
		const old = contextFactsBaseline(source);
		expect(resumeFactsNotice(old, contextFactsBaseline(source))).toBeUndefined();
		expect(resumeFactsNotice(old, contextFactsBaseline({ ...source, memoryIndex: null }))).toBe("Since the saved context snapshot, the memory index changed. The earlier context block reflects the session's start, not the current workspace. Read the current files or run git status if needed.");
		const changed = contextFactsBaseline({ ...source, contextFiles: [], memoryIndex: null, gitStatus: "new git" });
		expect(resumeFactsNotice(old, changed)).toContain("git status changed; the memory index changed; CLAUDE.md-family instructions changed");
		expect(resumeFactsNotice({ ...old, atCompaction: true }, changed)).toContain("reflects the latest compaction");
	});
});

describe("compaction refresh and resume differences", () => {
	let home: string;
	let cwd: string;
	let memory: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "context-facts-"));
		cwd = join(home, "project");
		mkdirSync(cwd);
		stubHome(home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 9, 1, 12));
		execFileSync("git", ["init", "-q", cwd]);
		execFileSync("git", ["-C", cwd, "config", "user.email", "first@example.invalid"]);
		writeFileSync(join(cwd, "CLAUDE.md"), "old instructions\n");
		writeFileSync(join(cwd, "ONECODE.md"), "old onecode\n");
		memory = join(projectMemoryDir(cwd, home), "MEMORY.md");
		mkdirSync(join(memory, ".."), { recursive: true });
		writeFileSync(memory, "old memory\n");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	async function open(branch: unknown[] = [], reason = "startup") {
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, sessionManager: { getBranch: () => branch } });
		await fake.fire("session_start", { reason }, ctx);
		fake.events.emit(GIT_SNAPSHOT_OWNER_CHANNEL, {});
		const turn = async () => {
			await fake.fire("before_agent_start", {}, ctx);
			await fake.fire("turn_start", {}, ctx);
		};
		const request = async (messages: unknown[]) => (await fake.fireOne<{ messages: unknown[] }>("context", { messages }, ctx))!.messages;
		return { fake, ctx, turn, request };
	}

	it("keeps earlier messages identical and emits one short first-resume notice for changed git, memory and rules", async () => {
		const first = await open();
		await first.turn();
		const earlier = [user("first", 1), user("second", 2)];
		const original = await first.request(earlier);
		const branch = branchOf(first.fake);
		writeFileSync(join(cwd, "new-file.txt"), "new git status\n");
		writeFileSync(join(cwd, "CLAUDE.md"), "new instructions\n");
		writeFileSync(memory, "new memory\n");
		const resumed = await open(branch, "resume");
		await resumed.turn();
		const messages = [...earlier, user("resume", 3)];
		const request = await resumed.request(messages);
		expect(JSON.stringify(request.slice(0, 2))).toBe(JSON.stringify(original));
		const tail = JSON.stringify(request[2]);
		expect(tail).toContain("git status changed; the memory index changed; CLAUDE.md-family instructions changed");
		expect(tail).toContain("earlier context block reflects the session's start");
		await resumed.turn();
		expect(await resumed.request(messages)).toEqual(request); // pinned, never duplicated
		expect(JSON.stringify(contextStackOnBranch([...branch, ...branchOf(resumed.fake)])!.stack)).toBe(JSON.stringify(contextStackOnBranch(branch)!.stack));
	});

	it("emits no resume difference when nothing changed", async () => {
		const first = await open();
		await first.turn();
		const old = [user("first", 1)];
		const original = await first.request(old);
		const resumed = await open(branchOf(first.fake));
		await resumed.turn();
		const messages = await resumed.request([...old, user("resume", 2)]);
		expect(messages[0]).toEqual(original[0]);
		expect(JSON.stringify(messages[1])).not.toContain("saved context snapshot");
	});

	it("compares a resumed session's facts in the directory they were taken in, not an entered worktree", async () => {
		const first = await open();
		await first.turn();
		await first.request([user("first", 1)]);
		const branch = branchOf(first.fake);
		const worktree = join(home, "worktree");
		mkdirSync(worktree);
		writeFileSync(join(worktree, "CLAUDE.md"), "worktree instructions\n");
		const resumed = await open(branch, "resume");
		resumed.fake.events.emit(WORKTREE_CHANNEL, { path: worktree });
		await resumed.turn();
		const messages = await resumed.request([user("first", 1), user("resume", 2)]);
		expect(JSON.stringify(messages[1])).not.toContain("saved context snapshot");
	});

	it.each(["manual", "threshold", "overflow"])("refreshes every fact after %s compaction and persists it before the next request", async (reason) => {
		const first = await open();
		await first.turn();
		await first.request([user("first", 1)]);
		const branch = branchOf(first.fake);
		const resumed = await open(branch);
		writeFileSync(join(cwd, "CLAUDE.md"), "fresh instructions\n");
		writeFileSync(join(cwd, "ONECODE.md"), "fresh onecode\n");
		writeFileSync(memory, "fresh memory\n");
		writeFileSync(join(cwd, "compaction-file.txt"), "new\n");
		execFileSync("git", ["-C", cwd, "config", "user.email", "second@example.invalid"]);
		vi.setSystemTime(new Date(2026, 9, 2, 12));
		await resumed.turn(); // pending resume/date notices must be cancelled by compaction
		await resumed.fake.fire("session_compact", { reason }, resumed.ctx);
		const savedBranch = [...branch, ...branchOf(resumed.fake)];
		const saved = contextStackOnBranch(savedBranch)!;
		const stackText = JSON.stringify(saved.stack);
		for (const text of ["fresh instructions", "fresh memory", "fresh onecode", "second@example.invalid", "compaction-file.txt", "2026-10-02", "latest compaction"]) expect(stackText).toContain(text);
		expect(stackText).not.toContain("old instructions");
		const summary = [{ role: "compactionSummary", summary: "summary", timestamp: 10 }];
		const refreshed = await resumed.request(summary);
		expect(JSON.stringify(refreshed)).not.toContain("Since the saved context snapshot");
		expect(JSON.stringify(refreshed)).not.toContain("The date has changed");
		const again = await open(savedBranch);
		await again.turn();
		expect(await again.request(summary)).toEqual(refreshed);
	});

	it("sends each branch its own message 1 when /tree crosses a compaction, in both directions", async () => {
		let branch: unknown[] = [];
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, sessionManager: { getBranch: () => branch } });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		fake.events.emit(GIT_SNAPSHOT_OWNER_CHANNEL, {});
		const turn = async () => {
			await fake.fire("before_agent_start", {}, ctx);
			await fake.fire("turn_start", {}, ctx);
		};
		const request = async (messages: unknown[]) => (await fake.fireOne<{ messages: unknown[] }>("context", { messages }, ctx))!.messages;
		await turn();
		const before = [user("first", 1)];
		const original = await request(before);
		const preCompaction = branchOf(fake);
		writeFileSync(join(cwd, "CLAUDE.md"), "fresh instructions\n");
		writeFileSync(memory, "fresh memory\n");
		vi.setSystemTime(new Date(2026, 9, 2, 12));
		await fake.fire("session_compact", { reason: "manual" }, ctx);
		const summary = [{ role: "compactionSummary", summary: "summary", timestamp: 10 }];
		const compacted = await request(summary);
		expect(JSON.stringify(compacted[0])).toContain("fresh instructions");
		const postCompaction = branchOf(fake);

		branch = preCompaction;
		await fake.fire("session_tree", {}, ctx);
		await turn();
		const back = await request([...before, user("second", 20)]);
		expect(JSON.stringify(back[0])).toBe(JSON.stringify(original[0]));
		// The branch was told 2026-10-01; today's date reaches it as a notice, never by rewriting message 1.
		expect(JSON.stringify(back[1])).toContain("The date has changed");
		expect(contextStackOnBranch([...preCompaction, ...branchOf(fake).slice(postCompaction.length)])!.stack).toEqual(contextStackOnBranch(preCompaction)!.stack);

		branch = postCompaction;
		await fake.fire("session_tree", {}, ctx);
		await turn();
		const forward = await request(summary);
		expect(JSON.stringify(forward[0])).toBe(JSON.stringify(compacted[0]));
		expect(JSON.stringify(forward)).not.toContain("The date has changed");
	});

	it("drops removed fact blocks at compaction instead of resurrecting their restored copies", async () => {
		const first = await open();
		await first.turn();
		await first.request([user("first", 1)]);
		const branch = branchOf(first.fake);
		const resumed = await open(branch);
		rmSync(join(cwd, "CLAUDE.md"));
		rmSync(join(cwd, "ONECODE.md"));
		rmSync(memory);
		await resumed.fake.fire("session_compact", { reason: "manual" }, resumed.ctx);
		const saved = contextStackOnBranch([...branch, ...branchOf(resumed.fake)]) as ContextStackSnapshot;
		expect(saved.stack.some((entry) => entry.key === "claude-context" || entry.key === "one-code-context")).toBe(false);
		expect(saved.stack.some((entry) => entry.key === "claude-context-date")).toBe(true);
	});
});
