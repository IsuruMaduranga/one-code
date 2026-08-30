import { describe, expect, it } from "vitest";
import { buildSkillBlock, parseSkillCommand, resolveSkill } from "../../extensions/skill/invoke.ts";

describe("parseSkillCommand", () => {
	it("returns undefined for non-skill input", () => {
		expect(parseSkillCommand("hello")).toBeUndefined();
		expect(parseSkillCommand("/skills")).toBeUndefined();
		expect(parseSkillCommand("/other:thing")).toBeUndefined();
	});

	it("parses a bare skill command", () => {
		expect(parseSkillCommand("/skill:simplify")).toEqual({ name: "simplify", args: "" });
	});

	it("splits the name from trailing args and trims them", () => {
		expect(parseSkillCommand("/skill:code-review  focus on the parser ")).toEqual({
			name: "code-review",
			args: "focus on the parser",
		});
	});

	it("keeps a plugin-namespaced name intact", () => {
		expect(parseSkillCommand("/skill:pr-review-toolkit:review-pr 123")).toEqual({
			name: "pr-review-toolkit:review-pr",
			args: "123",
		});
	});
});

describe("resolveSkill", () => {
	const all = [
		{ name: "simplify" },
		{ name: "code-review" },
		{ name: "pr-review-toolkit:review-pr" },
		{ name: "coderabbit:code-review" },
	];

	it("matches an exact name", () => {
		expect(resolveSkill(all, "simplify")).toEqual({ name: "simplify" });
	});

	it("matches case-insensitively", () => {
		expect(resolveSkill(all, "Simplify")).toEqual({ name: "simplify" });
	});

	it("resolves a unique plugin suffix from a bare name", () => {
		expect(resolveSkill(all, "review-pr")).toEqual({ name: "pr-review-toolkit:review-pr" });
	});

	it("refuses an ambiguous bare name across plugins", () => {
		// "code-review" exists both unprefixed and as coderabbit:code-review — the
		// exact match wins; but a bare name matching two plugins resolves to none.
		const plugins = [{ name: "a:thing" }, { name: "b:thing" }];
		expect(resolveSkill(plugins, "thing")).toBeUndefined();
	});

	it("returns undefined when nothing matches", () => {
		expect(resolveSkill(all, "nope")).toBeUndefined();
	});
});

describe("buildSkillBlock", () => {
	it("reproduces pi's skill block with the directory as the reference base", () => {
		const block = buildSkillBlock({ name: "simplify", filePath: "/skills/simplify/SKILL.md" }, "Do the thing.", "");
		expect(block).toBe(
			'<skill name="simplify" location="/skills/simplify/SKILL.md">\n' +
				"References are relative to /skills/simplify.\n\n" +
				"Do the thing.\n" +
				"</skill>",
		);
	});

	it("appends args after a blank line", () => {
		const block = buildSkillBlock({ name: "s", filePath: "/a/b/SKILL.md" }, "body", "extra instructions");
		expect(block.endsWith("</skill>\n\nextra instructions")).toBe(true);
	});
});
