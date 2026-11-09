/** Only the main session takes the git snapshot; a child session's context block has none. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/context/claude-context/index.ts";
import { GIT_SNAPSHOT_OWNER_CHANNEL } from "../../extensions/lib/context/git-status.ts";
import { makeRecord, RECORD } from "../../extensions/lib/request/ledger/records.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

describe("claude-context's git snapshot", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claude-context-git-"));
		stubHome(dir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, ".claude"));
		vi.stubEnv("GIT_AUTHOR_EMAIL", "a@b.com");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, "f.txt"), "x");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function contextBlock(owner: boolean, branch: unknown[] = []): Promise<string | undefined> {
		const fake = createFakePi();
		const texts: Array<{ key?: string; text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => texts.push(data as never));
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: dir, sessionManager: { getBranch: () => branch } });
		await fake.fireOne("session_start", {}, ctx);
		if (owner) fake.events.emit(GIT_SNAPSHOT_OWNER_CHANNEL, {});
		await fake.fireOne("turn_start", {}, ctx);
		return texts.find((t) => t.key === "claude-context-context")?.text;
	}

	/** The context block, the snapshot the base rendered into it, and the email spy. */
	async function snapshotIn(owner: boolean, branch: unknown[] = []) {
		const words = requireText("context");
		const gitStatus = vi.spyOn(words, "gitStatus");
		const email = vi.spyOn(words, "email");
		const block = await contextBlock(owner, branch);
		// The snapshot the session took (the base renders it at "start", and a
		// refreshed block swaps the profile's start heading for its compaction one).
		const taken = gitStatus.mock.calls.map((call) => call[0].snapshot).find((snapshot) => snapshot.status === "?? f.txt");
		gitStatus.mockRestore();
		/** Whether the block carries the snapshot rendered `at`. */
		const carries = (at: "start" | "compaction") => taken !== undefined && block !== undefined && block.includes(words.gitStatus({ snapshot: taken, at }));
		return { block, taken, email, carries };
	}

	it("is in the main session's context block", async () => {
		const { carries } = await snapshotIn(true);
		expect(carries("start")).toBe(true);
		expect(carries("compaction")).toBe(false);
	});

	it("is left out in a session nobody claimed it for (a child), which keeps the email", async () => {
		const { block, taken, email } = await snapshotIn(false);
		// No snapshot of this repository was rendered at all.
		expect(taken).toBeUndefined();
		expect(email).toHaveBeenCalledWith({ email: "a@b.com" });
		expect(block).toContain(email.mock.results.at(-1)!.value);
	});

	it("is the compaction's, not the conversation start's, when a process starts before the compaction's epoch opened (R3-L11)", async () => {
		const identity = { api: "anthropic-messages", provider: "acme", model: "m", auth: "key" };
		const branch = [
			{ type: "custom", id: "r1", parentId: null, customType: RECORD.request, data: makeRecord("request", "test", { identity, keep: 0, append: [], head: "h", blobs: { h: {} }, consumed: [], covers: { count: 1, role: "user", timestamp: 1 } }) },
			{ type: "message", id: "a1", parentId: "r1", message: { role: "assistant" } },
			{ type: "compaction", id: "c1", parentId: "a1" },
		];
		const { carries } = await snapshotIn(true, branch);
		expect(carries("compaction")).toBe(true);
		expect(carries("start")).toBe(false);
	});

	it("is the compaction's after a reload when no request settled before the compaction", async () => {
		const branch = [
			{ type: "message", id: "u1", parentId: null, message: { role: "user" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "error" } },
			{ type: "compaction", id: "c1", parentId: "a1" },
		];
		const { carries } = await snapshotIn(true, branch);
		expect(carries("compaction")).toBe(true);
		expect(carries("start")).toBe(false);
	});
});
