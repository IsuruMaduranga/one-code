/**
 * The code-review skill's cell choice: the cell picked per model tier and
 * effort, the effort read from the arguments or the session, and the body
 * built from the profile's cells. The cells' own texts and the other bundled
 * skills' wording are the profile's (One Code's:
 * profile/test/bundled-skill-texts-wording.test.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS_DIR } from "../../extensions/lib/plugins/skill-scan.ts";
import {
	type CellTable,
	codeReviewBody,
	codeReviewCell,
	parseCodeReviewArgs,
	readCellTable,
	REVIEW_EFFORTS,
	reviewEffortFor,
} from "../../extensions/tools/skill/code-review.ts";

const read = (...path: string[]) => readFileSync(join(BUNDLED_SKILLS_DIR, ...path), "utf-8").replace(/\r\n/g, "\n");
const cellsDir = join(BUNDLED_SKILLS_DIR, "code-review", "cells");
const cell = (name: string) => read("code-review", "cells", `${name}.md`);

describe("code-review cell choice", () => {
	it("takes a tier's own table, else the default one", () => {
		const efforts = (cell: string) => Object.fromEntries(REVIEW_EFFORTS.map((effort) => [effort, `${cell}-${effort}`])) as CellTable["tables"][string];
		const table: CellTable = { tables: { default: efforts("d"), frontier: efforts("f") } };
		expect(codeReviewCell(table, "frontier", "high")).toBe("f-high");
		for (const tier of ["workhorse", "cheap", "tiny"] as const) expect(codeReviewCell(table, tier, "max"), tier).toBe("d-max");
	});

	it("refuses a table without a complete default, naming the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "cells-"));
		try {
			writeFileSync(join(dir, "table.json"), JSON.stringify({ tables: { frontier: { low: "a" } } }));
			expect(() => readCellTable(dir)).toThrow(/table\.json: it has no "default" table; table "frontier" has no cell for "medium"/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
		const table = readCellTable(cellsDir);
		const picked = codeReviewCell(table, "workhorse", "xhigh");
		expect(review).toEqual({
			body: table.after ? `${cell(picked).trimEnd()}\n\n${cell(table.after).trimEnd()}` : cell(picked).trimEnd(),
			args: "feature-branch",
			cell: picked,
		});
	});

});
