/**
 * One Code's words for pi's read, write and edit results (Claude Code's file
 * tool texts). Which result gets which outcome is the base's:
 * test/unit/file-tracker-results.test.ts.
 */
import { describe, expect, it } from "vitest";
import { fileTracker } from "../text/file-tracker/index.ts";

const STATE = " (file state is current in your context — no need to read it back)";
const said = fileTracker.toolResult;

describe("One Code's file tool texts", () => {
	it("a write: created for a new file, updated for an existing one, with the absolute path", () => {
		expect(said({ kind: "written", path: "/p/notes.txt", created: true })).toBe(`File created successfully at: /p/notes.txt${STATE}`);
		expect(said({ kind: "written", path: "/p/notes.txt", created: false })).toBe(`The file /p/notes.txt has been updated successfully.${STATE}`);
	});

	it("a missing file names the working directory", () => {
		expect(said({ kind: "missing", cwd: "/p" })).toBe("File does not exist. Note: your current working directory is /p.");
	});

	it("a directory read names the path after the system's message", () => {
		expect(said({ kind: "isDirectory", path: "/p/notes.txt", osMessage: "EISDIR: illegal operation on a directory, read" })).toBe(
			"EISDIR: illegal operation on a directory, read '/p/notes.txt'",
		);
	});

	it("an empty file read warns that the file is empty", () => {
		expect(said({ kind: "empty" })).toBe("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
	});
});
