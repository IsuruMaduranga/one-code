/**
 * One Code's file-tracker wording (profile/text/file-tracker/): Claude Code's
 * texts for pi's read, write and edit results, the files put back after a
 * compaction, and the refusal of an edit to a file the model has not read,
 * plus what the golden snapshot cannot reach: a notice after a resume or
 * reload, an agent with no name, and an excerpt with nothing left out. The
 * golden snapshot pins the bytes of everything a one-shot run and the session
 * scenario reach. The base decides which result gets which outcome, which
 * files to put back and when to refuse an edit (test/unit/file-tracker.test.ts,
 * file-tracker-results.test.ts, file-tracker-restore.test.ts and
 * file-tracker-shell-reads.test.ts).
 */
import { describe, expect, it } from "vitest";
import { fileTracker } from "../text/file-tracker/index.ts";

const excerpt = { firstChangedLine: 1, numbered: "1\tnew", moreLines: 0 };

describe("One Code's file-tracker text", () => {
	it("lists the files that changed while the session was away", () => {
		expect(fileTracker.changedWhileAway({ paths: ["/p/a.ts", "/p/b.ts"] })).toBe(
			"These files changed on disk since you last read them in this conversation: /p/a.ts, /p/b.ts. Read them again before editing them.",
		);
	});

	it("names the agent that changed a file, or says an agent did", () => {
		expect(fileTracker.changedByAgent({ path: "/p/a.ts", agent: "Explore", excerpt })).toContain('was changed by the agent "Explore" you started');
		expect(fileTracker.changedByAgent({ path: "/p/a.ts", excerpt })).toContain("was changed by an agent you started");
	});

	it("adds the count of left-out lines only when the excerpt left some out", () => {
		expect(fileTracker.changedOnDisk({ path: "/p/a.ts", excerpt }).endsWith("re-read the file before editing it:\n1\tnew")).toBe(true);
		expect(fileTracker.changedOnDisk({ path: "/p/a.ts", excerpt: { ...excerpt, moreLines: 3 } }).endsWith("1\tnew\n… 3 more changed lines")).toBe(true);
	});
});

describe("One Code's file tool texts", () => {
	const STATE = " (file state is current in your context — no need to read it back)";
	const said = fileTracker.toolResult;

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

describe("One Code's restore texts", () => {
	it("words a restored file as Claude Code's read call and result, and a large one as a note", () => {
		expect(fileTracker.tooLargeToRestore({ path: "/w/big.txt" })).toBe(
			"Note: /w/big.txt was read before the last conversation was summarized, but the contents are too large to include. Use read tool if you need to access it.",
		);
		expect(fileTracker.restoredCall({ path: "/w/small.txt" })).toBe('Called the read tool with the following input: {"path":"/w/small.txt"}');
		expect(fileTracker.restoredResult({ text: "one\ntwo" })).toBe("Result of calling the read tool:\none\ntwo");
	});
});

describe("the unread refusal", () => {
	it("tells the model a cut-off shell output does not count as a read", () => {
		const text = fileTracker.unread({ path: "/p/a.ts", tool: "edit" });
		expect(text).toContain("a plain `cat`");
		expect(text).toContain("output cut off at the size limit");
		// A committed version printed by git is not the file on disk.
		expect(text).toContain("git show HEAD:<file>");
	});

	it("says a shell read counts only when it printed the whole file", () => {
		expect(fileTracker.unread({ path: "/p/big.py", tool: "edit" })).toContain("A shell read counts only when it printed the whole file as it is on disk");
	});
});
