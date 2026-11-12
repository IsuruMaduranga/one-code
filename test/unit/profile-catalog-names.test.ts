/**
 * The catalog entries the base reads by name, checked on the profile in
 * force. A product's profile swaps the agents/ and skills/ catalogs; one
 * that drops an entry the base names still loads, and the gap shows only
 * when that path runs (the Agent tool's default type, /loop's scheduling
 * hook, /code-review's cell table and the cells it names). This fails first.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS_DIR } from "../../extensions/lib/plugins/skill-scan.ts";
import { readCellTable } from "../../extensions/tools/skill/code-review.ts";
import { BUNDLED_AGENTS_DIR } from "../../extensions/lib/agents/agent-catalog.ts";
import { DEFAULT_AGENT } from "../../extensions/agents/subagents/runs.ts";


describe("the profile's catalogs", () => {
	it("ship the default agent type", () => {
		expect(existsSync(join(BUNDLED_AGENTS_DIR, `${DEFAULT_AGENT}.md`))).toBe(true);
	});

	it("ship the loop and code-review skills", () => {
		expect(existsSync(join(BUNDLED_SKILLS_DIR, "loop", "SKILL.md"))).toBe(true);
		expect(existsSync(join(BUNDLED_SKILLS_DIR, "code-review", "SKILL.md"))).toBe(true);
	});

	it("ship a code-review cell table and every cell it names", () => {
		const dir = join(BUNDLED_SKILLS_DIR, "code-review", "cells");
		const table = readCellTable(dir);
		const cells = new Set([...Object.values(table.tables).flatMap((efforts) => Object.values(efforts)), ...(table.after ? [table.after] : [])]);
		const missing = [...cells].filter((cell) => !existsSync(join(BUNDLED_SKILLS_DIR, "code-review", "cells", `${cell}.md`)));
		expect(missing).toEqual([]);
	});
});
