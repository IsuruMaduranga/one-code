import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import toolStyleExtension from "../../extensions/tool-style/index.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { SessionTurnTracker } from "../../extensions/subagents/session-turns.ts";
import { applyPostToolUseOutcome } from "../../extensions/hooks/protocol.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const text = (value: string) => ({ type: "text", text: value });
const marker = (name: string) => `(${name} completed with no output)`;

// Apply returned changes in registration order, as pi's emitToolResult does.
async function resultFor(content: unknown, name = "mcp__demo__silent", reminders = false, structuredContent?: unknown) {
	const fake = createFakePi();
	systemReminderExtension(fake.pi as never);
	if (reminders) fake.events.emit(REMINDER_CHANNEL, { text: "A file changed." });
	let event: any = { toolName: name, toolCallId: "c1", content, isError: false, input: {}, structuredContent };
	for (const handler of fake.handlers.get("tool_result") ?? []) {
		const change = await handler(event, createFakeCtx()) as any;
		if (change) {
			if (change.content !== undefined && change.structuredContent === undefined) delete event.structuredContent;
			event = { ...event, ...change };
		}
	}
	return event;
}

describe("Claude Code's empty tool-result marker", () => {
	it.each([undefined, null, "", " \t\n", [], [text("")], [text("\n"), text(" \t")]].map((content) => ({ content })))("replaces empty content $content", async ({ content }) => {
		expect((await resultFor(content)).content).toEqual([text(marker("mcp__demo__silent"))]);
	});

	it.each([[text("answer")], [{ type: "image", data: "image", mimeType: "image/png" }], [text(""), { type: "image" }]].map((content) => ({ content })))("keeps nonempty content $content", async ({ content }) => {
		expect((await resultFor(content)).content).toBe(content);
	});

	it("marks an empty PostToolUse replacement before retaining its reminder tail", () => {
		const reminder = text("<system-reminder>\nA file changed.\n</system-reminder>");
		expect(applyPostToolUseOutcome([text("old output"), reminder], { updatedToolResult: "" }, "mcp__demo__silent")).toEqual([
			text(marker("mcp__demo__silent")), reminder,
		]);
	});

	it("marks a hook's empty replacement of a read result; the raw-read exception is for pi's own bytes", () => {
		expect(applyPostToolUseOutcome([text("file body")], { updatedToolResult: "  " }, "read")).toEqual([text(marker("Read"))]);
	});

	it("adds the marker, preserves structured content, and leaves a pending reminder out of the stored result", async () => {
		const structuredContent = { exit_code: 0, output: "" };
		const result = await resultFor([], "bash", true, structuredContent);
		// The reminder rides the next request's tail instead (lib/reminders.ts).
		expect(result.content).toEqual([text(marker("Bash"))]);
		expect(result.structuredContent).toBe(structuredContent);
		expect(result.isError).toBe(false);
	});
});

describe("completed subagents without a reply", () => {
	it("returns Claude Code's completed-empty text without declaring a task failure", () => {
		const tracker = new SessionTurnTracker();
		tracker.beginTurn();
		tracker.process({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
		tracker.process({ type: "agent_settled" });
		expect(tracker.turnOutcome().output).toBe("(Subagent completed but returned no output.)");
		expect(tracker.turnOutcome().failed).toBeUndefined();
	});
});

describe("built-in empty results", () => {
	const dirs: string[] = [];
	afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

	it("keeps the empty-file warning after generic normalization, with no reminder in the stored result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "empty-result-read-"));
		dirs.push(dir);
		writeFileSync(join(dir, "empty.txt"), "");
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		toolStyleExtension(fake.pi as never);
		fileTrackerExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: dir });
		const result = await fake.tools.get("read")!.execute("r1", { path: "empty.txt" }, undefined, undefined, ctx) as any;
		fake.events.emit(REMINDER_CHANNEL, { text: "A file changed." });
		let event: any = { ...result, toolName: "read", toolCallId: "r1", input: { path: "empty.txt" }, isError: false };
		for (const handler of fake.handlers.get("tool_result") ?? []) {
			const change = await handler(event, ctx);
			if (change) event = { ...event, ...change };
		}
		expect(event.content[0].text).toBe("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
		expect(event.content).toHaveLength(1);
	});

	it.each([
		{ source: " \t\n", args: {}, expected: " \t\n" },
		{ source: "hello\n", args: { offset: 2 }, expected: "" },
	])("does not mistake Read's raw blank file bytes for an empty mapped result: $source", async ({ source, args, expected }) => {
		const dir = mkdtempSync(join(tmpdir(), "empty-result-blank-read-"));
		dirs.push(dir);
		writeFileSync(join(dir, "blank.txt"), source);
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		toolStyleExtension(fake.pi as never);
		fileTrackerExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: dir });
		const input = { path: "blank.txt", ...args };
		const result = await fake.tools.get("read")!.execute("r2", input, undefined, undefined, ctx) as any;
		let event: any = { ...result, toolName: "read", toolCallId: "r2", input, isError: false };
		for (const handler of fake.handlers.get("tool_result") ?? []) {
			const change = await handler(event, ctx);
			if (change) event = { ...event, ...change };
		}
		expect(event.content).toEqual([text(expected)]);
	});

	it("uses Claude Code's Glob no-files text for pi find", async () => {
		const dir = mkdtempSync(join(tmpdir(), "empty-result-find-"));
		dirs.push(dir);
		const fake = createFakePi();
		toolStyleExtension(fake.pi as never);
		const result = await fake.tools.get("find")!.execute("f1", { pattern: "*.absent" }, undefined, undefined, createFakeCtx({ cwd: dir })) as any;
		expect((await resultFor(result.content, "find")).content).toEqual([text("No files found")]);
	});
});
