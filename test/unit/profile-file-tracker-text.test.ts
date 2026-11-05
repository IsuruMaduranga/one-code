/**
 * One Code's file-tracker wording (profile/file-tracker/) where the golden
 * snapshot cannot reach it: a notice after a resume or reload, an agent with
 * no name, and an excerpt with nothing left out. The golden snapshot pins
 * the bytes of everything a one-shot run and the session scenario reach.
 */
import { describe, expect, it } from "vitest";
import { fileTracker } from "../../profile/file-tracker/index.ts";

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
