/**
 * file-tracker across /reload, resume and /tree: the read state and what the
 * model was told are rebuilt from the branch alone (round-3 report R3-M15,
 * R3-L8, R3-L9). Each test runs the real system-reminder and file-tracker on a
 * fake pi whose branch is the session file: a one-shot is persisted there as
 * a `one-code:pending` entry, and `load()` again on the same entries is a
 * reload (pi re-runs every extension factory).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

type Entry = FakePi["branch"][number];

describe("file-tracker read state follows the branch", () => {
	let dir: string;
	let entries: Entry[];
	let fake: FakePi;
	let notices: string[];

	/** New extension instances on the session's entries (a /reload, a resume), started with `reason`. */
	const load = async (reason = "reload", cwd = dir) => {
		fake = createFakePi();
		fake.branch.push(...entries);
		entries = fake.branch;
		systemReminderExtension(fake.pi as never);
		fileTrackerExtension(fake.pi as never);
		notices = [];
		fake.events.on(REMINDER_CHANNEL, (data) => notices.push(String((data as { text?: string }).text)));
		await fake.fire("session_start", { reason }, ctx(cwd));
	};
	const ctx = (cwd = dir) => createFakeCtx({ cwd, sessionManager: { getSessionId: () => "s1", getBranch: () => fake.branch } });
	let ids = 0;
	const push = (entry: Omit<Entry, "id" | "parentId">) => fake.branch.push({ ...entry, id: `m${++ids}`, parentId: fake.branch.at(-1)?.id ?? null } as Entry);

	/**
	 * A file tool call as pi runs and stores it: the hook sees `input` (the
	 * worktree's rewritten clone), the transcript keeps `args` (the model's own
	 * spelling), and the result keeps the details the hook returned.
	 */
	const toolCall = async (name: string, input: Record<string, unknown>, args = input, cwd = dir) => {
		const id = `c${++ids}`;
		push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
		const results = await fake.fire<{ details?: unknown } | undefined>("tool_result", { toolName: name, toolCallId: id, input, isError: false, content: [{ type: "text", text: "ok" }] }, ctx(cwd));
		const details = results.find((result) => result?.details)?.details;
		push({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, isError: false, content: [{ type: "text", text: "ok" }], ...(details ? { details } : {}) } });
	};
	const edit = (file: string, cwd = dir) => fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", { toolName: "edit", toolCallId: "e", input: { path: file } }, ctx(cwd));
	const compact = async () => {
		push({ type: "compaction", firstKeptEntryId: null, timestamp: new Date().toISOString() } as never);
		const compaction = fake.branch.at(-1)!;
		await fake.fire("session_compact", { compactionEntry: compaction, fromExtension: true, reason: "manual", willRetry: false }, ctx());
	};

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "file-tracker-lifecycle-"));
		entries = [];
		await load("startup");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	describe("R3-M15: the replay keys on each result's recorded absolute path", () => {
		it("after a reload inside a worktree, the worktree file the model read is read and its main-checkout twin is not", async () => {
			const worktree = join(dir, ".claude", "worktrees", "w1");
			mkdirSync(worktree, { recursive: true });
			const main = join(dir, "a.ts");
			const inWorktree = join(worktree, "a.ts");
			writeFileSync(main, "main checkout\n");
			writeFileSync(inWorktree, "worktree copy\n");
			// The model read `a.ts`; the worktree rewrote the call to the worktree's file.
			await toolCall("read", { path: inWorktree }, { path: "a.ts" });
			expect(await edit(inWorktree)).toBeUndefined();

			await load("reload");
			expect(await edit(inWorktree)).toBeUndefined();
			const twin = await edit(main);
			expect(twin?.block).toBe(true);
			expect(twin?.reason).toContain("has not been read");
		});

		it("never takes the disk as seen for a read that recorded no observation: an edit needs a fresh read", async () => {
			const file = join(dir, "old.ts");
			writeFileSync(file, "changed after the read\n");
			// A result with no record of what it saw (a session from before the record existed).
			push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "r0", name: "read", arguments: { path: file } }] } });
			push({ type: "message", message: { role: "toolResult", toolCallId: "r0", isError: false } });
			await load("resume");
			expect((await edit(file))?.block).toBe(true);
		});

		it("rebuilds the post-compaction restore's order from the recorded paths, so a worktree file comes back after a reload", async () => {
			const worktree = join(dir, "wt");
			mkdirSync(worktree);
			const inWorktree = join(worktree, "b.ts");
			writeFileSync(inWorktree, "worktree text\n");
			await toolCall("read", { path: inWorktree }, { path: "b.ts" }, worktree);
			await load("reload");
			await compact();
			expect(notices.some((text) => text.includes("worktree text"))).toBe(true);
		});
	});

	describe("R3-L8: a file a compaction restored stays read across a reload", () => {
		it("counts the restored file read after a reload, whether or not its restore was delivered yet", async () => {
			const file = join(dir, "small.txt");
			writeFileSync(file, "one\ntwo\n");
			await toolCall("read", { path: file });
			await compact();
			expect(notices.some((text) => text.startsWith("Result of calling the read tool:\none\ntwo"))).toBe(true);
			expect(await edit(file)).toBeUndefined();

			await load("reload");
			expect(await edit(file)).toBeUndefined();
			await load("resume");
			expect(await edit(file)).toBeUndefined();
		});

		it("takes a restored file that changed since as stale, and says so once", async () => {
			const file = join(dir, "moved.txt");
			writeFileSync(file, "restored text\n");
			await toolCall("read", { path: file });
			await compact();
			writeFileSync(file, "someone else's text\n");
			await load("reload");
			const blocked = await edit(file);
			expect(blocked?.block).toBe(true);
			expect(blocked?.reason).toContain("has changed on disk");
			expect(notices.filter((text) => text.includes(file))).toHaveLength(1);
		});

		it("drops a restore that a later compaction summarized away", async () => {
			const file = join(dir, "twice.txt");
			writeFileSync(file, "restored once\n");
			await toolCall("read", { path: file });
			await compact();
			// The second compaction keeps nothing: the restore's text is gone from context.
			push({ type: "compaction", firstKeptEntryId: null, timestamp: new Date().toISOString() } as never);
			await load("reload");
			expect((await edit(file))?.reason).toContain("has not been read");
		});
	});

	describe("R3-L9: a change the model was told about is not announced again", () => {
		it("after a reload, a change already reported is not reported again, and the file stays stale", async () => {
			const file = join(dir, "c.ts");
			writeFileSync(file, "before\n");
			await toolCall("read", { path: file });
			writeFileSync(file, "after\n");
			await fake.fire("agent_start", {}, ctx());
			expect(notices.filter((text) => text.includes(file))).toHaveLength(1);

			await load("reload");
			expect(notices.filter((text) => text.includes(file))).toEqual([]);
			expect((await edit(file))?.reason).toContain("has changed on disk");
		});

		it("reports a change found at a resume once, however many reloads follow", async () => {
			const file = join(dir, "d.ts");
			writeFileSync(file, "before\n");
			await toolCall("read", { path: file });
			writeFileSync(file, "while closed\n");
			await load("resume");
			expect(notices.filter((text) => text.includes(file))).toHaveLength(1);
			await load("reload");
			await load("reload");
			expect(notices.filter((text) => text.includes(file))).toEqual([]);
		});

		it("reports a version newer than the one it told about, and a change again after the model read the file", async () => {
			const file = join(dir, "e.ts");
			writeFileSync(file, "one\n");
			await toolCall("read", { path: file });
			writeFileSync(file, "two\n");
			await fake.fire("agent_start", {}, ctx());
			writeFileSync(file, "three\n");
			await load("reload");
			expect(notices.filter((text) => text.includes(file))).toHaveLength(1);

			// The model reads the file, which changes back to a version it was told about before that read.
			await toolCall("read", { path: file });
			writeFileSync(file, "two\n");
			await load("reload");
			expect(notices.filter((text) => text.includes(file))).toHaveLength(1);
		});
	});
});
