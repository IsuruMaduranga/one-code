/**
 * One Code's words for empty results, Claude Code's: a tool that returned
 * nothing, a subagent that replied with nothing, and pi's find matching no
 * file. Where the base puts them: test/unit/empty-tool-result.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";
import { subagentsText } from "../text/subagents/index.ts";
import { toolResults } from "../text/tool-results/index.ts";

describe("One Code's empty-result texts", () => {
	it("names the tool that completed with no output", () => {
		expect(toolResults.empty({ tool: "mcp__demo__silent" })).toBe("(mcp__demo__silent completed with no output)");
		expect(toolResults.empty({ tool: "Bash" })).toBe("(Bash completed with no output)");
	});

	it("says a subagent returned no output", () => {
		expect(subagentsText(ALL_LIVE).noOutput).toBe("(Subagent completed but returned no output.)");
	});

	it("uses Claude Code's Glob no-files text for pi find", () => {
		expect(toolResults.noFilesFound).toBe("No files found");
	});
});
