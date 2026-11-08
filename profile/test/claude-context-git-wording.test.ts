/** One Code's git snapshot headings: Claude Code's, at the conversation's start or the latest compaction. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

const snapshot = { branch: "master", mainBranch: "master", user: "", status: "?? f.txt", commits: "" };

describe("git snapshot wording", () => {
	it("heads the snapshot by when it was taken", () => {
		const words = requireText("context");
		expect(words.gitStatus({ snapshot, at: "start" })).toContain("# gitStatus\nThis is the git status at the start of the conversation.");
		expect(words.gitStatus({ snapshot, at: "compaction" })).toContain("This is the git status at the latest compaction.");
		expect(words.email({ email: "a@b.com" })).toContain("# userEmail");
	});
});
