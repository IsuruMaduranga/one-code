/**
 * pi's read, write and edit results, rewritten to Claude Code's texts
 * (file-tracker/results.ts) and wired through the file-tracker's tool_result
 * hook. The input strings are pi's exact wording.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import { fileToolResultContent } from "../../extensions/file-tracker/results.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const STATE = " (file state is current in your context — no need to read it back)";
const text = (t: string) => [{ type: "text", text: t }];
const rewritten = (toolName: string, isError: boolean, t: string, extra: Record<string, unknown> = {}) =>
	fileToolResultContent({ toolName, isError, content: text(t), path: "/p/notes.txt", cwd: "/p", ...extra })?.[0]?.text;

describe("Claude Code's file tool texts", () => {
	it("write: created for a new file, updated for an existing one", () => {
		expect(rewritten("write", false, "Successfully wrote to notes.txt")).toBe(`File created successfully at: /p/notes.txt${STATE}`);
		expect(rewritten("write", false, "Successfully wrote to notes.txt", { existedBefore: true })).toBe(
			`The file /p/notes.txt has been updated successfully.${STATE}`,
		);
	});

	it("edit: updated, with the absolute path", () => {
		expect(rewritten("edit", false, "Successfully replaced 2 block(s) in notes.txt.")).toBe(`The file /p/notes.txt has been updated successfully.${STATE}`);
	});

	it("a missing file, for read and edit", () => {
		const missing = "File does not exist. Note: your current working directory is /p.";
		expect(rewritten("read", true, "ENOENT: no such file or directory, access '/p/notes.txt'")).toBe(missing);
		expect(rewritten("edit", true, "Could not edit file: notes.txt. Error code: ENOENT.")).toBe(missing);
	});

	it("a directory read names the path", () => {
		expect(rewritten("read", true, "EISDIR: illegal operation on a directory, read")).toBe("EISDIR: illegal operation on a directory, read '/p/notes.txt'");
	});

	it("an empty file read warns that the file is empty, only when it is", () => {
		expect(rewritten("read", false, "", { isEmptyFile: () => true })).toBe(
			"<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
		);
		expect(rewritten("read", false, "", { isEmptyFile: () => false })).toBeUndefined();
	});

	it("leaves everything else alone, and keeps the blocks after the first", () => {
		expect(rewritten("read", false, "hello\n")).toBeUndefined();
		expect(rewritten("edit", true, "Could not find the exact text in notes.txt.")).toBeUndefined();
		expect(rewritten("write", true, "Successfully wrote to notes.txt")).toBeUndefined();
		expect(rewritten("bash", false, "Successfully wrote to notes.txt")).toBeUndefined();
		const content = [...text("Successfully wrote to notes.txt"), { type: "text", text: "<total_tokens>9 tokens left</total_tokens>" }];
		expect(fileToolResultContent({ toolName: "write", isError: false, content, path: "/p/notes.txt", cwd: "/p" })?.[1]).toBe(content[1]);
	});
});

describe("file-tracker: the result texts are wired", () => {
	let dir: string;
	let fake: FakePi;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-tracker-results-"));
		fake = createFakePi();
		fileTrackerExtension(fake.pi as never);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const ctx = () => createFakeCtx({ cwd: dir });
	const call = async (toolName: string, toolCallId: string, path: string, result: string, isError = false) => {
		await fake.fireOne("tool_call", { toolName, toolCallId, input: { path } }, ctx());
		return (await fake.fireOne<{ content: Array<{ text: string }> }>("tool_result", { toolName, toolCallId, input: { path }, isError, content: text(result) }, ctx()))
			?.content[0].text;
	};

	it("says created for a new file and updated once it exists, and the file then counts as read", async () => {
		const file = join(dir, "a.txt");
		// Existence is checked at tool_call time, before pi's write creates the file.
		await fake.fireOne("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "a.txt" } }, ctx());
		writeFileSync(file, "one");
		const created = await fake.fireOne<{ content: Array<{ text: string }> }>(
			"tool_result",
			{ toolName: "write", toolCallId: "w1", input: { path: "a.txt" }, isError: false, content: text("Successfully wrote to a.txt") },
			ctx(),
		);
		expect(created?.content[0].text).toBe(`File created successfully at: ${file}${STATE}`);
		// The tool said the state is current: the next write is not refused as unread.
		expect(await call("write", "w2", "a.txt", "Successfully wrote to a.txt")).toBe(`The file ${file} has been updated successfully.${STATE}`);
	});

	it("rewrites a read of a missing file and of a directory", async () => {
		mkdirSync(join(dir, "sub"));
		expect(await call("read", "r1", "nope.txt", `ENOENT: no such file or directory, access '${join(dir, "nope.txt")}'`, true)).toBe(
			`File does not exist. Note: your current working directory is ${dir}.`,
		);
		expect(await call("read", "r2", "sub", "EISDIR: illegal operation on a directory, read", true)).toBe(
			`EISDIR: illegal operation on a directory, read '${join(dir, "sub")}'`,
		);
	});

	it("warns on an empty file read", async () => {
		writeFileSync(join(dir, "empty.txt"), "");
		expect(await call("read", "r3", "empty.txt", "")).toBe("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
	});
});
