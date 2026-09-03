/**
 * file-tracker/index.ts wiring (T15a): handler sequencing across tool_call /
 * tool_result / before_agent_start, plus the session_start / session_tree
 * replay reconstruction — as opposed to tracker.ts's pure state machine,
 * already covered by file-tracker.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("file-tracker wiring", () => {
	let dir: string;
	let fake: FakePi;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-tracker-wiring-"));
		fake = createFakePi();
		fileTrackerExtension(fake.pi as never);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const path = (name: string) => join(dir, name);
	const ctx = () => createFakeCtx({ cwd: dir });

	it("blocks an edit to an existing file that was never read", async () => {
		const file = path("a.ts");
		writeFileSync(file, "original");
		const result = await fake.fireOne<{ block?: boolean; reason?: string }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("has not been read");
	});

	it("allows the edit once the file has been read, then observes the write", async () => {
		const file = path("b.ts");
		writeFileSync(file, "original");

		// A read tool_result marks the file as seen.
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx());
		const allowed = await fake.fireOne<{ block?: boolean }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(allowed).toBeUndefined();

		// Our own edit result re-observes the new content, so a second edit
		// (without an intervening external change) is not blocked as stale.
		writeFileSync(file, "changed by our edit");
		await fake.fireOne("tool_result", { toolName: "edit", input: { path: file }, isError: false }, ctx());
		const second = await fake.fireOne<{ block?: boolean }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(second).toBeUndefined();
	});

	it("blocks a stale edit when the file changed on disk after we read it", async () => {
		const file = path("c.ts");
		writeFileSync(file, "v1");
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx());

		// Someone/something else changes the file out of band (e.g. via bash).
		writeFileSync(file, "v2 - changed externally");

		const blocked = await fake.fireOne<{ block?: boolean; reason?: string }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("changed on disk");
	});

	it("allows creating a brand-new file with no prior read", async () => {
		const file = path("new.ts");
		const result = await fake.fireOne<{ block?: boolean }>(
			"tool_call",
			{ toolName: "write", input: { path: file } },
			ctx(),
		);
		expect(result).toBeUndefined();
	});

	it("reports external changes as a system-reminder on before_agent_start, without marking the file read", async () => {
		const file = path("d.ts");
		writeFileSync(file, "before");
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx());

		writeFileSync(file, "after");
		const emitted: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data));

		await fake.fireOne("before_agent_start", {}, ctx());
		expect(emitted).toHaveLength(1);
		expect((emitted[0] as { text: string }).text).toContain(file);
		expect((emitted[0] as { text: string }).text).toContain("after");

		// The stale-edit guard must still fire: before_agent_start's notice does
		// NOT count as a re-read, or the model could clobber the external change.
		const blocked = await fake.fireOne<{ block?: boolean }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(blocked?.block).toBe(true);

		// A second before_agent_start with no further change must not repeat the
		// same warning (DETAILED_CHANGE_REMINDERS_PER_TURN / alreadyNotified).
		emitted.length = 0;
		await fake.fireOne("before_agent_start", {}, ctx());
		expect(emitted).toHaveLength(0);
	});

	it("reconstructs read state from the session branch on session_start (resume)", async () => {
		const file = path("resumed.ts");
		writeFileSync(file, "resumed content");
		const branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: file } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "1", isError: false } },
		];
		await fake.fireOne("session_start", { reason: "resume" }, createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "s1", getBranch: () => branch } }));

		// Because the branch already read it, an edit needs no fresh read.
		const result = await fake.fireOne<{ block?: boolean }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(result).toBeUndefined();
	});

	it("starts a fresh tracker on session_tree when the session id changes", async () => {
		const file = path("e.ts");
		writeFileSync(file, "content");
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx());

		// A different session id (e.g. switching sessions) resets the tracker,
		// so the previously-read file is unread again in the new session.
		await fake.fireOne(
			"session_tree",
			{},
			createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "different-session", getBranch: () => [] } }),
		);
		const result = await fake.fireOne<{ block?: boolean }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(result?.block).toBe(true);
	});
});
