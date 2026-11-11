/**
 * The skill results' wording for the results the golden
 * snapshot cannot reach: an ambiguous plugin skill name, an unreadable skill,
 * the listing for a session that reads skill files with the shell, and the
 * refusal of a user-only skill. The golden snapshot pins the bytes of every
 * other text.
 */
import { describe, expect, it } from "vitest";
import { skillResultText } from "../../extensions/tools/skill/text.ts";

describe("the skill text", () => {
	it("asks for the full name when plugins share a skill name", () => {
		expect(skillResultText.ambiguous({ query: "review", wanted: "review", matches: ["a:review", "b:review"] })).toBe(
			'"review" is ambiguous — it matches a:review, b:review. Use the full `<plugin>:review` name.',
		);
	});

	it("tells the model a user-only skill is the user's to run", () => {
		expect(skillResultText.userOnly("beta")).toContain("only the user can run it, by typing /beta");
	});

	it("reports an unreadable skill with the system's reason", () => {
		expect(skillResultText.readFailed({ name: "x", osMessage: "EACCES" })).toBe('Could not read skill "x": EACCES');
	});

	it("frames the file listing for the reader the session has", () => {
		expect(skillResultText.readableListing({ lines: ["- a (/s/a/SKILL.md)"], reader: "shell" })).toBe(
			"The following skills provide specialized instructions for specific tasks. Read a skill's file with the shell when the task matches its description:\n\n- a (/s/a/SKILL.md)",
		);
		expect(skillResultText.readableListing({ lines: ["- a"], reader: "read" })).toContain("with the read tool when");
	});
});
