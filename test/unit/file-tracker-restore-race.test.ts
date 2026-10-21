/**
 * The post-compaction restore marks a file read only as the version its
 * block showed: a file that changed while it was read back and then changed
 * back must not count as read, or the stale-edit guard would pass an edit
 * planned against the version in between.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Writes run around the next read-back of a file, to stage a change while it is read. */
const aroundRead: { before?: () => void; after?: () => void } = {};

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		createReadToolDefinition: (...args: Parameters<typeof actual.createReadToolDefinition>) => {
			const tool = actual.createReadToolDefinition(...args);
			return {
				...tool,
				execute: async (...call: Parameters<typeof tool.execute>) => {
					aroundRead.before?.();
					const result = await tool.execute(...call);
					aroundRead.after?.();
					return result;
				},
			};
		},
	};
});

const { default: fileTrackerExtension } = await import("../../extensions/file-tracker/index.ts");
const { REMINDER_CHANNEL } = await import("../../extensions/lib/reminders.ts");
const { createFakeCtx, createFakePi } = await import("./helpers/fake-pi.ts");

describe("file-tracker post-compaction restore race", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-tracker-restore-race-"));
	});
	afterEach(() => {
		aroundRead.before = undefined;
		aroundRead.after = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not mark a file read when it went A to B and back to A while the restore read it", async () => {
		const fake = createFakePi();
		fileTrackerExtension(fake.pi as never);
		const file = join(dir, "a.txt");
		writeFileSync(file, "version A\n");
		const ctx = createFakeCtx({ cwd: dir });
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx);
		const emitted: Array<{ text: string; observations?: unknown[] }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data as { text: string; observations?: unknown[] }));

		aroundRead.before = () => writeFileSync(file, "version B\n");
		aroundRead.after = () => writeFileSync(file, "version A\n");
		const branch = [{ type: "compaction", id: "c1", firstKeptEntryId: "c1" }];
		await fake.fire(
			"session_compact",
			{ compactionEntry: branch[0], fromExtension: true, reason: "manual", willRetry: false },
			createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "s", getBranch: () => branch } }),
		);

		const shown = emitted.find((r) => r.text.startsWith("Result of calling the read tool:"));
		expect(shown?.text).toContain("version B");
		expect(shown?.observations).toBeUndefined();
		const edit = await fake.fireOne<{ block?: boolean }>("tool_call", { toolName: "edit", input: { path: file } }, ctx);
		expect(edit?.block).toBe(true);
	});

	it("marks a file read as the version its block showed when nothing changed", async () => {
		const fake = createFakePi();
		fileTrackerExtension(fake.pi as never);
		const file = join(dir, "a.txt");
		writeFileSync(file, "version A\n");
		const ctx = createFakeCtx({ cwd: dir });
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx);
		const emitted: Array<{ text: string; observations?: unknown[] }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data as { text: string; observations?: unknown[] }));

		const branch = [{ type: "compaction", id: "c1", firstKeptEntryId: "c1" }];
		await fake.fire(
			"session_compact",
			{ compactionEntry: branch[0], fromExtension: true, reason: "manual", willRetry: false },
			createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "s", getBranch: () => branch } }),
		);

		const shown = emitted.find((r) => r.text.startsWith("Result of calling the read tool:"));
		expect(shown?.observations).toHaveLength(1);
		expect(await fake.fireOne("tool_call", { toolName: "edit", input: { path: file } }, ctx)).toBeUndefined();
	});
});
