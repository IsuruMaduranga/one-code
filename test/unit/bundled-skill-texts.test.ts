/**
 * The bundled skills' texts that mirror Claude Code's: code-review's cells
 * (locked by hash; each is Claude Code's text, the minimal prompt reporting
 * through the JSON array), the cell chosen per tier and effort, and the
 * simplify, security-review and code-review wording.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatterLoosely } from "../../extensions/lib/frontmatter.ts";
import { BUNDLED_SKILLS_DIR } from "../../extensions/lib/skill-scan.ts";
import {
	codeReviewBody,
	codeReviewCell,
	parseCodeReviewArgs,
	REVIEW_EFFORTS,
	reviewEffortFor,
} from "../../extensions/skill/code-review.ts";

const read = (...path: string[]) => readFileSync(join(BUNDLED_SKILLS_DIR, ...path), "utf-8").replace(/\r\n/g, "\n");
const cellsDir = join(BUNDLED_SKILLS_DIR, "code-review", "cells");
const cell = (name: string) => read("code-review", "cells", `${name}.md`);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const skill = (name: string) => parseFrontmatterLoosely(read(name, "SKILL.md")) as { frontmatter: Record<string, string>; body: string };

describe("code-review cells", () => {
	it("keeps each cell's text", () => {
		expect(
			Object.fromEntries(
				[
					"low-1-pass-max4",
					"minimal-prompt",
					"high-8-inline",
					"xhigh-10-inline-sweep",
					"max-5x5-verify-sweep",
					"low-1-pass-min-files-4",
					"medium-3x5-verify",
					"high-3x5-recall-verify",
					"xhigh-5x5-verify-sweep",
					"arguments-and-flags",
				].map((name) => [name, sha(cell(name))]),
			),
		).toEqual({
			"low-1-pass-max4": "aab0c3accfb83b7f",
			"minimal-prompt": "6e1206a2df65eb06",
			"high-8-inline": "516ccdfb07907249",
			"xhigh-10-inline-sweep": "a2562b061214e5b6",
			"max-5x5-verify-sweep": "83be9fd7fe19ec14",
			"low-1-pass-min-files-4": "17d08f61da0d865c",
			"medium-3x5-verify": "2b21359570ee3318",
			"high-3x5-recall-verify": "6a3724cb7c8602cd",
			"xhigh-5x5-verify-sweep": "bc366818befc6f1c",
			"arguments-and-flags": "509387c151f4f8e2",
		});
	});

	it("has the minimal prompt report through the JSON array, since One Code has no findings tool", () => {
		const text = cell("minimal-prompt");
		expect(text.startsWith("`minimal prompt → single careful diff pass → ≤15 findings`\n\nYou are reviewing a pull request for real bugs.")).toBe(true);
		expect(text).not.toContain("via the ReportFindings tool");
		expect(text).not.toContain("After the tool call");
		expect(text).toContain("Return findings as a JSON array of at most 15 objects:");
	});

	it("maps frontier to Claude Code's default table and the other tiers to its Sonnet 5 table", () => {
		const table = (tier: "frontier" | "workhorse" | "cheap" | "tiny") => REVIEW_EFFORTS.map((effort) => codeReviewCell(tier, effort));
		expect(table("frontier")).toEqual(["low-1-pass-max4", "minimal-prompt", "high-8-inline", "xhigh-10-inline-sweep", "max-5x5-verify-sweep"]);
		const sonnet5 = ["low-1-pass-min-files-4", "medium-3x5-verify", "high-3x5-recall-verify", "xhigh-5x5-verify-sweep", "max-5x5-verify-sweep"];
		for (const tier of ["workhorse", "cheap", "tiny"] as const) expect(table(tier), tier).toEqual(sonnet5);
	});

	it("reads the effort from a typed level first, else the session's thinking level", () => {
		expect(["off", "minimal", "low", "medium", "high", "xhigh", "max", undefined].map(reviewEffortFor)).toEqual([
			"low",
			"low",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"medium",
		]);
		expect(parseCodeReviewArgs("HIGH 123 --fix")).toEqual({ effort: "high", rest: "123 --fix" });
		expect(parseCodeReviewArgs("max")).toEqual({ effort: "max", rest: "" });
		expect(parseCodeReviewArgs(" 123 high")).toEqual({ rest: "123 high" });
		expect(parseCodeReviewArgs("")).toEqual({ rest: "" });
		const review = codeReviewBody(cellsDir, "workhorse", "off", "xhigh feature-branch");
		expect(review).toEqual({
			body: `${cell("xhigh-5x5-verify-sweep").trimEnd()}\n\n${cell("arguments-and-flags").trimEnd()}`,
			args: "feature-branch",
			cell: "xhigh-5x5-verify-sweep",
		});
	});

	it("keeps SKILL.md's own body as the Sonnet 5 medium cell, for a session that cannot read the cells", () => {
		const { frontmatter, body } = skill("code-review");
		expect(body.trim()).toBe(`${cell("medium-3x5-verify").trimEnd()}\n\n${cell("arguments-and-flags").trimEnd()}`);
		expect(frontmatter.description.replace(/\s+/g, " ").trim()).toBe(
			"Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simplification/efficiency cleanups where the model's review recipe covers them) at the given effort level (low/medium: fewer, high-confidence findings; high→max: broader coverage, may include uncertain findings); with no level given, it follows the session's effort (/effort). Pass --comment to post findings as inline PR comments, or --fix to apply the findings to the working tree after the review.",
		);
		expect(frontmatter["argument-hint"]).toBe("[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]");
	});
});

describe("simplify and security-review wording", () => {
	it("uses Claude Code's Altitude paragraph and listing description in simplify", () => {
		const { frontmatter, body } = skill("simplify");
		expect(body).toContain(
			"### Altitude\n\nCheck that each change fixes the root cause at the right depth rather than\npatching a symptom with a fragile bandaid. Special cases layered on shared\ninfrastructure are a sign the fix isn't deep enough — prefer the simpler, more\ngeneral change to the underlying mechanism over adding special cases, and name\nthat change.\n",
		);
		expect(frontmatter.description.replace(/\s+/g, " ").trim()).toBe(
			"Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.",
		);
	});

	it("uses Claude Code's one-line listing description for security-review", () => {
		expect(skill("security-review").frontmatter.description).toBe("Complete a security review of the pending changes on the current branch");
	});

	it("splits loop's when_to_use out of its description, as Claude Code declares it", () => {
		const { frontmatter } = skill("loop");
		expect(frontmatter.description).toBe("Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.");
		expect(frontmatter.when_to_use.startsWith("When the user wants to set up a recurring task")).toBe(true);
	});
});
