/**
 * The code-review skill's cell choice: the cell picked per model tier and
 * effort, the effort read from the arguments or the session, and the body
 * built from the profile's cells. The cells' own texts and the other bundled
 * skills' wording are the profile's (One Code's:
 * profile/test/bundled-skill-texts-wording.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS_DIR } from "../../extensions/lib/plugins/skill-scan.ts";
import {
	codeReviewBody,
	codeReviewCell,
	parseCodeReviewArgs,
	REVIEW_EFFORTS,
	reviewEffortFor,
} from "../../extensions/tools/skill/code-review.ts";

const read = (...path: string[]) => readFileSync(join(BUNDLED_SKILLS_DIR, ...path), "utf-8").replace(/\r\n/g, "\n");
const cellsDir = join(BUNDLED_SKILLS_DIR, "code-review", "cells");
const cell = (name: string) => read("code-review", "cells", `${name}.md`);

describe("code-review cell choice", () => {
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

});
