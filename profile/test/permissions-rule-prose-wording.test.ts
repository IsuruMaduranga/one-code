/**
 * One Code's wording of a user's deny rule in the classifier's HARD BLOCK list
 * (profile/text/auto-mode/classifier.ts `userDenyRule`): it describes the rule
 * by effect, keeps its instruction intact under the spec's bound, and names
 * the rule so a verdict citing it grounds. The base's
 * permissions-rule-prose.test.ts checks what it hands the profile.
 */
import { describe, expect, it } from "vitest";
import { buildRuleset, defaultEnvironment } from "../../extensions/permissions/auto-mode/classifier-prompt.ts";
import { buildCategoryIndex, groundCategory } from "../../extensions/permissions/auto-mode/rules.ts";
import { denyRuleLines } from "../../extensions/permissions/rule-prose.ts";

describe("One Code's deny-rule line", () => {
	it("describes a deny rule by effect, not by its pattern syntax", () => {
		const [line] = denyRuleLines(["Bash(rm:*)"]);
		expect(line).toContain("`Bash(rm:*)`");
		expect(line).toContain("BLOCK the action under review");
		// The point of the whole change: the rule must bind more than its spelling.
		expect(line).toContain("whatever command, interpreter, script or tool");
		// A rule is a decision made in advance, so the intent tier must not clear it.
		expect(line).toContain("user intent does NOT clear it");
	});

	it("keeps the instruction intact when the spec is bounded", () => {
		const long = denyRuleLines([`Bash(${"x".repeat(2000)}:*)`]);
		expect(long[0]).toContain("BLOCK the action under review");
		expect(long[0].length).toBeLessThan(500);
	});

	it("names a bare tool rule with no pattern", () => {
		const [line] = denyRuleLines(["WebFetch"]);
		expect(line).toMatch(/^User Deny Rule WebFetch:/);
	});

	it("grounds a verdict citing the rule by its name", () => {
		const index = buildCategoryIndex(buildRuleset(defaultEnvironment(), { hardDeny: denyRuleLines(["Bash(rm:*)", "Edit(src/**)"]) }));
		expect(groundCategory(index, "User Deny Rule Bash rm")?.tier).toBe("hard_deny");
		expect(groundCategory(index, "User Deny Rule Edit src/")?.tier).toBe("hard_deny");
	});
});
