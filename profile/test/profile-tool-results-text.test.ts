/**
 * One Code's tool-result and tool-call-corruption wording (profile/) where
 * the golden snapshot cannot reach it: a save that failed, a denial with the
 * user's words, and the corruption blocks (OpenRouter streaming damaged
 * arguments). The golden snapshot pins the empty results, a persisted output
 * and a denial without words.
 */
import { describe, expect, it } from "vitest";
import { userDenialKind, userDenialText } from "../../extensions/lib/user-denial.ts";
import { toolCallCorruption } from "../../profile/text/tool-call-corruption/index.ts";
import { toolResults } from "../../profile/text/tool-results/index.ts";

describe("One Code's tool-result text", () => {
	it("says when a large output could not be saved", () => {
		expect(toolResults.persisted({ size: "2MB", file: "/r/x.txt", saveError: "EACCES" })).toBe(
			"Output too large (2MB) and could not be saved to /r/x.txt: EACCES. Only this preview survives — re-run with a narrower query if more is needed.",
		);
	});

	it("carries the user's words in a denial, and the base reads both kinds back", () => {
		const withWords = userDenialText("use pnpm");
		expect(withWords).toContain("To tell you how to proceed, the user said:\nuse pnpm");
		expect(userDenialKind(withWords)).toBe("reason");
		expect(userDenialKind(userDenialText())).toBe("stop");
		expect(userDenialKind("something else")).toBeUndefined();
	});
});

describe("One Code's tool-call-corruption text", () => {
	it("words the damage and both blocks", () => {
		const reason = toolCallCorruption.damage({ kind: "cutAfterOption", option: "-rn" });
		expect(reason).toBe('The shell command ends with "-rn" and nothing after it, the shape of arguments cut off before a quoted string.');
		expect(toolCallCorruption.suspectBlock({ reason })).toContain("It was not run. Send the complete command again");
		expect(toolCallCorruption.corruptBlock({ reason, repeat: true })).toContain("An earlier command in this run came through cut the same way. Do not retry this call");
		expect(toolCallCorruption.corruptBlock({ reason, repeat: false })).not.toContain("An earlier command");
	});
});
