/**
 * One Code's side of the file-tracker wiring: the cases that need Claude
 * Code's instruction files (an external `@` import, an oversized CLAUDE.md)
 * and the wording of a change notice. The wiring on any profile is in
 * test/unit/file-tracker-wiring.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fileTrackerExtension from "../../extensions/safety/file-tracker/index.ts";
import { discoverContextFiles } from "../claude-code/instructions.ts";
import { persistExternalIncludesApproval } from "../../extensions/lib/context/external-includes.ts";
import { resetConfigModeForTest } from "../claude-code/mode.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "../../test/unit/helpers/fake-pi.ts";
import { stubHome } from "../../test/unit/helpers/home.ts";

describe("file-tracker wiring: Claude Code's instruction files and One Code's words", () => {
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

	it("words a change made during the turn with Claude Code's steer", async () => {
		const file = path("f.ts");
		writeFileSync(file, "before");
		await fake.fireOne("tool_result", { toolName: "read", input: { path: file }, isError: false }, ctx());
		const emitted: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push((data as { text: string }).text));
		writeFileSync(file, "before\nformatted");
		await fake.fireOne("tool_execution_end", { toolName: "bash", toolCallId: "b1", isError: false }, ctx());
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toContain(
			`Note: ${file} changed on disk since you last read it. That's usually deliberate, so take it as the current state rather than reverting it; if the change looks wrong, say so rather than undoing it yourself — otherwise no need to call it out. Here are the relevant changes (shown with line numbers); re-read the file before editing it:\n`,
		);
		expect(emitted[0]).toContain("formatted");
	});

	it.each([false, true])("retains an external instruction import's read state only when its contents are in context (approved: %s)", async (approved) => {
		const home = path("home");
		const project = path("project");
		mkdirSync(project);
		stubHome(home);
		resetConfigModeForTest("claude-compatible");
		try {
			const imported = path("external.md");
			writeFileSync(imported, "EXTERNAL IMPORT CONTENT\n");
			writeFileSync(join(project, "CLAUDE.md"), "@../external.md\n");
			persistExternalIncludesApproval(project, home, approved);
			const shown = discoverContextFiles({ cwd: project, home, homeClaudeDir: join(home, ".claude"), rule: "claude-md", includeExternal: approved });
			expect(shown.some((file) => file.content.includes("EXTERNAL IMPORT CONTENT"))).toBe(approved);
			const branch = [{ type: "compaction", id: "c", firstKeptEntryId: "c" }];
			const context = createFakeCtx({ cwd: project, sessionManager: { getBranch: () => branch } });
			await fake.fireOne("tool_result", { toolName: "read", input: { path: imported }, isError: false }, context);
			await fake.fire("session_compact", { compactionEntry: branch[0], fromExtension: true, reason: "manual", willRetry: false }, context);
			const result = await fake.fireOne<{ block?: boolean }>("tool_call", { toolName: "write", input: { path: imported } }, context);
			expect(result?.block === true).toBe(!approved);
		} finally {
			vi.unstubAllEnvs();
			resetConfigModeForTest();
		}
	});

	it("does not count a CLAUDE.md over half the window as in context after a compaction", async () => {
		const home = path("home");
		const project = path("project-big");
		mkdirSync(project);
		stubHome(home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
		resetConfigModeForTest("claude-compatible");
		try {
			const big = join(project, "CLAUDE.md");
			writeFileSync(big, `BIG-RULES ${"x".repeat(24_000)}\n`);
			const emitted: string[] = [];
			fake.events.on(REMINDER_CHANNEL, (data) => emitted.push((data as { text: string }).text));
			const branch = [{ type: "compaction", id: "c", firstKeptEntryId: "c" }];
			// A 1,000-token window: message 1 carries only a note for this file.
			const context = createFakeCtx({ cwd: project, model: { provider: "t", id: "small", api: "t", contextWindow: 1_000 }, sessionManager: { getSessionId: () => "s", getBranch: () => branch } });
			await fake.fireOne("tool_result", { toolName: "read", input: { path: big }, isError: false }, context);
			await fake.fire("session_compact", { compactionEntry: branch[0], fromExtension: true, reason: "manual", willRetry: false }, context);
			const result = await fake.fireOne<{ block?: boolean }>("tool_call", { toolName: "write", input: { path: big } }, context);
			// Either the restore brought its contents back, or the read state is gone: never read but unseen.
			expect(result?.block === true || emitted.some((text) => text.includes("BIG-RULES"))).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			resetConfigModeForTest();
		}
	});
});
