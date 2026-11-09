/**
 * The shapes the base reads from the profile's classifier ruleset
 * (`ClassifierRuleset` in extensions/permissions/auto-mode/text.ts), checked on the
 * profile in force. A ruleset that renames a rule-list heading or changes a
 * rule's bullet form still compiles, but every block it cites would match no
 * rule and /permissions would count none; this fails first.
 */
import { describe, expect, it } from "vitest";
import { buildRuleset, classifierText, defaultEnvironment, renderSessionContext } from "../../extensions/permissions/auto-mode/classifier-prompt.ts";
import { buildCategoryIndex, builtinRuleCounts } from "../../extensions/permissions/auto-mode/rules.ts";

describe("the profile's classifier ruleset", () => {
	const ruleset = buildRuleset(defaultEnvironment());

	it("has rules under each of the three rule-list headings", () => {
		const counts = builtinRuleCounts(ruleset);
		expect(counts.hard_deny).toBeGreaterThan(0);
		expect(counts.soft_deny).toBeGreaterThan(0);
		expect(counts.allow).toBeGreaterThan(0);
	});

	it("indexes every hard and soft rule by name, for the blocks the classifier cites", () => {
		const counts = builtinRuleCounts(ruleset);
		const tiers = buildCategoryIndex(ruleset).rules.map((rule) => rule.tier);
		expect(tiers.filter((tier) => tier === "hard_deny")).toHaveLength(counts.hard_deny);
		expect(tiers.filter((tier) => tier === "soft_deny")).toHaveLength(counts.soft_deny);
	});

	it("appends a user's rules inside the matching list", () => {
		const extended = buildRuleset(defaultEnvironment(), { hardDeny: ["Shape Probe Hard: x"], softDeny: ["Shape Probe Soft: x"], allow: ["Shape Probe Allow: x"] });
		const base = builtinRuleCounts(ruleset);
		expect(builtinRuleCounts(extended)).toEqual({ hard_deny: base.hard_deny + 1, soft_deny: base.soft_deny + 1, allow: base.allow + 1 });
		expect(buildCategoryIndex(extended).byName.get("shape probe hard")?.tier).toBe("hard_deny");
		expect(buildCategoryIndex(extended).byName.get("shape probe soft")?.tier).toBe("soft_deny");
	});

	it("marks where the username goes", () => {
		expect(classifierText().sessionContext).toContain("__USERNAME__");
		expect(renderSessionContext("shape-probe-user")).toContain("shape-probe-user");
	});
});
