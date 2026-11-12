import { describe, expect, it } from "vitest";
import { buildRuleset, classifierText, defaultEnvironment } from "../../extensions/safety/permissions/auto-mode/classifier-prompt.ts";
import { buildCategoryIndex, groundCategory, normalizeName } from "../../extensions/safety/permissions/auto-mode/rules.ts";
import { denyRuleLines } from "../../extensions/safety/permissions/rule-prose.ts";

describe("denyRuleLines", () => {
	it("hands the profile a scan-safe name and the rule verbatim", () => {
		// The name drops the punctuation the rule-name scan cuts at; the spec keeps the rule's spelling.
		expect(denyRuleLines(["Bash(rm:*)"])).toEqual([classifierText().userDenyRule("Bash rm", "Bash(rm:*)")]);
		expect(denyRuleLines(["Read(~/**)"])).toEqual([classifierText().userDenyRule("Read ~/", "Read(~/**)")]);
	});

	it("skips malformed rules and de-duplicates", () => {
		expect(denyRuleLines(["", "   ", "((("])).toEqual([]);
		expect(denyRuleLines(["Bash(rm:*)", "Bash(rm:*)"])).toHaveLength(1);
	});

	it("bounds the number of rules and the length of each", () => {
		const many = Array.from({ length: 60 }, (_, i) => `Bash(cmd${i}:*)`);
		const lines = denyRuleLines(many);
		expect(lines).toHaveLength(25);
		// The bound is on the quoted spec (120 characters) and the name (60): the instruction must survive intact.
		const long = denyRuleLines([`Bash(${"x".repeat(2000)}:*)`]);
		expect(long).toEqual([classifierText().userDenyRule(`Bash ${"x".repeat(55)}`, `Bash(${"x".repeat(114)}…`)]);
	});

	it("renders a bare tool rule with no pattern", () => {
		expect(denyRuleLines(["WebFetch"])).toEqual([classifierText().userDenyRule("WebFetch", "WebFetch")]);
	});
});

describe("injected deny rules ground as HARD BLOCK categories", () => {
	// The load-bearing property: a stage-2 verdict citing an injected rule must
	// ground, or the block is downgraded to `unmatched` and loses the rule's
	// authority. `rules.ts` cuts a rule name at the first ":" or " [", and rule
	// specs contain both, which is why the name carries a stripped form.
	it("indexes each rule's name and grounds a verdict citing it", () => {
		const lines = denyRuleLines(["Bash(rm:*)", "Edit(src/**)"]);
		const index = buildCategoryIndex(buildRuleset(defaultEnvironment(), { hardDeny: lines }));
		const builtins = new Set(buildCategoryIndex(buildRuleset(defaultEnvironment())).rules.map((rule) => rule.name));
		const injected = index.rules.filter((rule) => !builtins.has(rule.name));
		expect(injected).toHaveLength(2);
		for (const rule of injected) expect(groundCategory(index, rule.name)?.tier, rule.name).toBe("hard_deny");
	});

	it("grounds a verdict that quotes the whole rule line", () => {
		const lines = denyRuleLines(["Bash(rm:*)"]);
		const index = buildCategoryIndex(buildRuleset(defaultEnvironment(), { hardDeny: lines }));
		expect(groundCategory(index, lines[0])?.tier).toBe("hard_deny");
	});

	it("leaves the built-in rules and the default ruleset untouched", () => {
		const bare = buildRuleset(defaultEnvironment());
		const withRules = buildRuleset(defaultEnvironment(), { hardDeny: denyRuleLines(["Bash(rm:*)"]) });
		// Additive only: the default prompt is a prefix-compatible subset.
		expect(buildCategoryIndex(bare).rules.length).toBeGreaterThan(0);
		expect(buildCategoryIndex(withRules).rules.length).toBe(buildCategoryIndex(bare).rules.length + 1);
		// And an empty deny list changes nothing at all.
		expect(buildRuleset(defaultEnvironment(), { hardDeny: denyRuleLines([]) })).toBe(bare);
	});

	it("a name that collides with a built-in rule does not steal its tier", () => {
		// `byName` keeps the first (HARD) binding, so a user line cannot rename a
		// built-in rule; check the built-in still grounds as itself.
		const index = buildCategoryIndex(buildRuleset(defaultEnvironment(), { hardDeny: denyRuleLines(["Bash(rm:*)"]) }));
		const builtins = buildCategoryIndex(buildRuleset(defaultEnvironment())).rules;
		for (const rule of builtins) {
			expect(groundCategory(index, rule.name)?.tier, rule.name).toBe(rule.tier);
		}
		expect(normalizeName("User Deny Rule Bash rm")).toBe("user deny rule bash rm");
	});
});
