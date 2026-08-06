import { describe, expect, it } from "vitest";
import {
	buildCompactionInstruction,
	COMPACTION_INSTRUCTION,
	continuationSummary,
	extractSummary,
} from "../../extensions/compaction/prompt.ts";

describe("COMPACTION_INSTRUCTION", () => {
	it("carries the Claude Code prompt's load-bearing pieces", () => {
		expect(COMPACTION_INSTRUCTION.startsWith("CRITICAL: Respond with TEXT ONLY.")).toBe(true);
		expect(COMPACTION_INSTRUCTION).toContain("1. Primary Request and Intent");
		expect(COMPACTION_INSTRUCTION).toContain("6. All user messages");
		expect(COMPACTION_INSTRUCTION).toContain("9. Optional Next Step");
		expect(COMPACTION_INSTRUCTION).toContain("security-relevant instructions or constraints");
		expect(COMPACTION_INSTRUCTION.trimEnd().endsWith("Tool calls will be rejected and you will fail the task.")).toBe(
			true,
		);
	});
});

describe("buildCompactionInstruction", () => {
	it("holds the trigger notice and the instruction in one system-reminder", () => {
		const manual = buildCompactionInstruction({ reason: "manual" });
		expect(manual).toBe(
			`<system-reminder>\nThe user has triggered a /compact command to summarize this conversation to reduce token usage and reduce the context window.\n${COMPACTION_INSTRUCTION}\n</system-reminder>`,
		);
		for (const reason of ["threshold", "overflow"] as const) {
			expect(buildCompactionInstruction({ reason })).toContain(
				"The conversation context window is running out. You must summarize the conversation immediately",
			);
		}
	});

	it("front-loads compact instructions as included context, ahead of the CRITICAL header", () => {
		const text = buildCompactionInstruction({ reason: "manual", customInstructions: "focus on test output" });
		expect(text).toContain("<system-reminder>\n## Compact Instructions\nfocus on test output\n</system-reminder>");
		expect(text.indexOf("## Compact Instructions")).toBeLessThan(text.indexOf("CRITICAL: Respond"));
	});

	it("never carries the previous summary — that is reattached as a context message upstream", () => {
		const text = buildCompactionInstruction({ reason: "threshold" });
		expect(text).not.toContain("previous-summary");
	});
});

describe("continuationSummary", () => {
	it("prefixes the stored summary with the continuation preamble", () => {
		expect(continuationSummary("1. Primary Request: x")).toBe(
			"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n1. Primary Request: x",
		);
	});

	it("points at the full transcript with a do-not-read-whole warning", () => {
		const text = continuationSummary("body", "/home/u/.pi/agent/sessions/--proj--/abc.jsonl");
		expect(text).toContain("full transcript of the summarized conversation is at /home/u/.pi/agent/sessions/--proj--/abc.jsonl");
		expect(text).toContain("NEVER read it whole");
		expect(text).toContain("grep");
		// --no-session runs have no file; the pointer line is dropped, not empty.
		expect(continuationSummary("body")).not.toContain("transcript");
	});
});

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
