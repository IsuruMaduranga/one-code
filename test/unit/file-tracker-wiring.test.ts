/**
 * file-tracker/index.ts wiring (T15a): handler sequencing across tool_call /
 * tool_result / agent_start, plus the session_start / session_tree
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

	it("reports external changes as a system-reminder on agent_start, without marking the file read", async () => {
		const file = path("d.ts");
		writeFileSync(file, "before");
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx());

		writeFileSync(file, "after");
		const emitted: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data));

		await fake.fireOne("agent_start", {}, ctx());
		expect(emitted).toHaveLength(1);
		expect((emitted[0] as { text: string }).text).toContain(file);
		expect((emitted[0] as { text: string }).text).toContain("after");

		// The stale-edit guard must still fire: agent_start's notice does
		// NOT count as a re-read, or the model could clobber the external change.
		const blocked = await fake.fireOne<{ block?: boolean }>(
			"tool_call",
			{ toolName: "edit", input: { path: file } },
			ctx(),
		);
		expect(blocked?.block).toBe(true);

		// A second agent_start with no further change must not repeat the
		// same warning (DETAILED_CHANGE_REMINDERS_PER_TURN / alreadyNotified).
		emitted.length = 0;
		await fake.fireOne("agent_start", {}, ctx());
		expect(emitted).toHaveLength(0);
	});

	it("reports a change made during the turn at the end of the next tool execution, with Claude Code's steer, and does not report our own writes", async () => {
		const file = path("f.ts");
		writeFileSync(file, "before");
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx());
		const emitted: Array<{ text: string; placement?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data as { text: string }));

		// Our own edit: the tool_result handler observes the new content first
		// (pi runs tool_result hooks before tool_execution_end), so it is fresh.
		writeFileSync(file, "our edit");
		await fake.fireOne("tool_result", { toolName: "edit", input: { path: file }, isError: false }, ctx());
		await fake.fireOne("tool_execution_end", { toolName: "edit", toolCallId: "e1", isError: false }, ctx());
		expect(emitted).toHaveLength(0);

		// A formatter rewrites the file while a later tool (say bash) runs: the
		// change is reported when that tool's execution ends — mid-turn, before the
		// model's next edit — as a one-shot (default placement, pinned to that result).
		writeFileSync(file, "our edit\nformatted");
		await fake.fireOne("tool_execution_end", { toolName: "bash", toolCallId: "b1", isError: false }, ctx());
		expect(emitted).toHaveLength(1);
		expect(emitted[0].placement).toBeUndefined();
		const text = emitted[0].text;
		expect(text).toContain(`Note: ${file} was modified, either by the user, a linter, or a command`);
		expect(text).toContain("This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware.");
		expect(text).toContain("re-read the file before editing it");
		expect(text).toContain("formatted");

		// Still stale for the edit guard, and not reported twice.
		const blocked = await fake.fireOne<{ block?: boolean }>("tool_call", { toolName: "edit", input: { path: file } }, ctx());
		expect(blocked?.block).toBe(true);
		await fake.fireOne("tool_execution_end", { toolName: "bash", toolCallId: "b2", isError: false }, ctx());
		await fake.fireOne("agent_start", {}, ctx());
		expect(emitted).toHaveLength(1);
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
