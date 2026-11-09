/**
 * One Code's tool-result and tool-call-corruption wording (profile/) where
 * the golden snapshot cannot reach it: a save that failed, a denial with the
 * user's words, and the corruption blocks (OpenRouter streaming damaged
 * arguments). It also checks the empty results and the saved-output pointer
 * in Claude Code's words. The golden snapshot pins the empty results, a
 * persisted output and a denial without words.
 */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { userDenialKind, userDenialText } from "../../extensions/lib/consent/user-denial.ts";
import { toolCallCorruption } from "../text/tool-call-corruption/index.ts";
import { toolResults } from "../text/tool-results/index.ts";

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

	it("names the file the whole output was saved to", () => {
		expect(requireText("toolResults").persisted({ size: "305.6KB", file: "/tmp/out.log" })).toContain("Full output saved to: /tmp/out.log");
	});

	it("names the tool that completed with no output", () => {
		expect(toolResults.empty({ tool: "mcp__demo__silent" })).toBe("(mcp__demo__silent completed with no output)");
		expect(toolResults.empty({ tool: "Bash" })).toBe("(Bash completed with no output)");
	});

	it("uses Claude Code's Glob no-files text for pi find", () => {
		expect(toolResults.noFilesFound).toBe("No files found");
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
