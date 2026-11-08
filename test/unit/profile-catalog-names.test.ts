/**
 * The catalog entries the base reads by name, checked on the profile in
 * force. A product's profile swaps the agents/ and skills/ catalogs; one
 * that drops an entry the base names still loads, and the gap shows only
 * when that path runs (the Agent tool's default type, /loop's scheduling
 * hook, /code-review's body for some tier and effort). This fails first.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS_DIR } from "../../extensions/lib/skill-scan.ts";
import { ARGUMENTS_AND_FLAGS, codeReviewCell, REVIEW_EFFORTS } from "../../extensions/skill/code-review.ts";
import { BUNDLED_AGENTS_DIR } from "../../extensions/subagents/agents.ts";
import { DEFAULT_AGENT } from "../../extensions/subagents/runs.ts";
import type { PromptTier } from "../../extensions/lib/model-tier.ts";

const TIERS: PromptTier[] = ["frontier", "workhorse", "cheap", "tiny"];

describe("the profile's catalogs", () => {
	it("ship the default agent type", () => {
		expect(existsSync(join(BUNDLED_AGENTS_DIR, `${DEFAULT_AGENT}.md`))).toBe(true);
	});

	it("ship the loop and code-review skills", () => {
		expect(existsSync(join(BUNDLED_SKILLS_DIR, "loop", "SKILL.md"))).toBe(true);
		expect(existsSync(join(BUNDLED_SKILLS_DIR, "code-review", "SKILL.md"))).toBe(true);
	});

	it("ship every code-review cell a tier and effort can pick", () => {
		const cells = new Set([ARGUMENTS_AND_FLAGS, ...TIERS.flatMap((tier) => REVIEW_EFFORTS.map((effort) => codeReviewCell(tier, effort)))]);
		const missing = [...cells].filter((cell) => !existsSync(join(BUNDLED_SKILLS_DIR, "code-review", "cells", `${cell}.md`)));
		expect(missing).toEqual([]);
	});
});
