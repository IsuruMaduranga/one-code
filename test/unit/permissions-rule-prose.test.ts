import { describe, expect, it } from "vitest";
import { buildRuleset, DEFAULT_ENVIRONMENT } from "../../extensions/auto-mode/classifier-prompt.ts";
import { buildCategoryIndex, groundCategory, normalizeName } from "../../extensions/auto-mode/rules.ts";
import { denyRuleLines } from "../../extensions/permissions/rule-prose.ts";

describe("denyRuleLines", () => {
	it("describes a deny rule by effect, not by its pattern syntax", () => {
		const [line] = denyRuleLines(["Bash(rm:*)"]);
		expect(line).toContain("`Bash(rm:*)`");
		expect(line).toContain("BLOCK the action under review");
		// The point of the whole change: the rule must bind more than its spelling.
		expect(line).toContain("whatever command, interpreter, script or tool");
		// A rule is a decision made in advance, so the intent tier must not clear it.
		expect(line).toContain("user intent does NOT clear it");
	});

	it("skips malformed rules and de-duplicates", () => {
		expect(denyRuleLines(["", "   ", "((("])).toEqual([]);
		expect(denyRuleLines(["Bash(rm:*)", "Bash(rm:*)"])).toHaveLength(1);
	});

	it("bounds the number of rules and the length of each", () => {
		const many = Array.from({ length: 60 }, (_, i) => `Bash(cmd${i}:*)`);
		const lines = denyRuleLines(many);
		expect(lines).toHaveLength(25);
		// The bound is on the quoted spec: the instruction must survive intact.
		const long = denyRuleLines([`Bash(${"x".repeat(2000)}:*)`]);
		expect(long[0]).toContain("BLOCK the action under review");
		expect(long[0].length).toBeLessThan(500);
	});

	it("renders a bare tool rule with no pattern", () => {
		const [line] = denyRuleLines(["WebFetch"]);
		expect(line).toMatch(/^User Deny Rule WebFetch:/);
	});
});

describe("injected deny rules ground as HARD BLOCK categories", () => {
	// The load-bearing property: a stage-2 verdict citing an injected rule must
	// ground, or the block is downgraded to `unmatched` and loses the rule's
	// authority. `rules.ts` cuts a rule name at the first ":" or " [", and rule
	// specs contain both, which is why the name carries a stripped form.
	it("indexes the rule name and grounds a verdict citing it", () => {
		const lines = denyRuleLines(["Bash(rm:*)", "Edit(src/**)"]);
		const ruleset = buildRuleset([...DEFAULT_ENVIRONMENT], { hardDeny: lines });
		const index = buildCategoryIndex(ruleset);

		const rm = groundCategory(index, "User Deny Rule Bash rm");
		expect(rm).toBeDefined();
		expect(rm?.tier).toBe("hard_deny");

		const edit = groundCategory(index, "User Deny Rule Edit src/");
		expect(edit?.tier).toBe("hard_deny");
	});

	it("grounds a verdict that quotes the whole rule line", () => {
		const lines = denyRuleLines(["Bash(rm:*)"]);
		const index = buildCategoryIndex(buildRuleset([...DEFAULT_ENVIRONMENT], { hardDeny: lines }));
		expect(groundCategory(index, lines[0])?.tier).toBe("hard_deny");
	});

	it("leaves the built-in rules and the default ruleset untouched", () => {
		const bare = buildRuleset([...DEFAULT_ENVIRONMENT]);
		const withRules = buildRuleset([...DEFAULT_ENVIRONMENT], { hardDeny: denyRuleLines(["Bash(rm:*)"]) });
		// Additive only: the default prompt is a prefix-compatible subset.
		expect(buildCategoryIndex(bare).rules.length).toBeGreaterThan(0);
		expect(buildCategoryIndex(withRules).rules.length).toBe(buildCategoryIndex(bare).rules.length + 1);
		// And an empty deny list changes nothing at all.
		expect(buildRuleset([...DEFAULT_ENVIRONMENT], { hardDeny: denyRuleLines([]) })).toBe(bare);
	});

	it("a name that collides with a built-in rule does not steal its tier", () => {
		// `byName` keeps the first (HARD) binding, so a user line cannot rename a
		// built-in rule; check the built-in still grounds as itself.
		const index = buildCategoryIndex(buildRuleset([...DEFAULT_ENVIRONMENT], { hardDeny: denyRuleLines(["Bash(rm:*)"]) }));
		const builtins = buildCategoryIndex(buildRuleset([...DEFAULT_ENVIRONMENT])).rules;
		for (const rule of builtins) {
			expect(groundCategory(index, rule.name)?.tier, rule.name).toBe(rule.tier);
		}
		expect(normalizeName("User Deny Rule Bash rm")).toBe("user deny rule bash rm");
	});
});
