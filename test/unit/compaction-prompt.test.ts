/**
 * Reading the summary out of a compaction reply: the `<summary>` block, with
 * the analysis dropped. One Code's instruction text itself is
 * profile/test/profile-compaction-text.test.ts.
 */
import { describe, expect, it } from "vitest";
import { extractSummary } from "../../extensions/compaction/prompt.ts";

describe("extractSummary", () => {
	it("keeps only the summary block, dropping the analysis scratch work", () => {
		const reply = "<analysis>\nthinking...\n</analysis>\n\n<summary>\n1. Primary Request: build x\n</summary>";
		expect(extractSummary(reply)).toBe("1. Primary Request: build x");
	});

	it("spans to the last closing tag so embedded example tags cannot truncate it", () => {
		const reply = "<summary>part one </summary> quoted inside <summary> part two</summary>";
		expect(extractSummary(reply)).toBe("part one </summary> quoted inside <summary> part two");
	});

	it("ignores tag mentions inside the analysis — the first live run's failure", () => {
		// The analysis discussed the requested format; the loose regex anchored
		// on the backtick-quoted mention and kept the analysis tail as summary.
		const reply = [
			"<analysis>",
			"The user asked for output wrapped in `<analysis>` and `<summary>` sections. No code was modified.",
			"</analysis>",
			"",
			"<summary>",
			"1. Primary Request: build x",
			"</summary>",
		].join("\n");
		expect(extractSummary(reply)).toBe("1. Primary Request: build x");
	});

	it("uses an untagged reply whole rather than losing the compaction to a formatting slip", () => {
		expect(extractSummary("<analysis>x</analysis>\nplain summary text")).toBe("plain summary text");
		expect(extractSummary("just text")).toBe("just text");
	});

	it("reports nothing usable as undefined", () => {
		expect(extractSummary("<summary>   </summary>")).toBeUndefined();
		expect(extractSummary("<analysis>only scratch</analysis>")).toBeUndefined();
		expect(extractSummary("")).toBeUndefined();
	});
});
