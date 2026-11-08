/**
 * One Code's words for the MCP change notices: a recovered server, a newly
 * connected one's instructions in Claude Code's frame, a failure and a
 * disconnect. Which notices the base sends, and in what order:
 * test/unit/mcp-announce.test.ts.
 */
import { describe, expect, it } from "vitest";
import { mcpChangeNotices as changeNotices, type McpDelta } from "../../extensions/mcp/announce.ts";
import { mcp as mcpText } from "../text/mcp/index.ts";

const mcpChangeNotices = (d: McpDelta) => changeNotices(d, mcpText);

describe("One Code's MCP change notices", () => {
	it("renders one notice per kind of change, instructions in Claude Code's frame", () => {
		const texts = mcpChangeNotices({
			newInstructions: [{ name: "deepwiki", instructions: "Use ask_question." }],
			newFailures: [{ name: "gh", error: "401 bad token" }],
			recovered: ["ctx7"],
			dropped: ["old"],
			facts: [],
		});
		expect(texts).toHaveLength(4);
		expect(texts[0]).toContain("ctx7");
		expect(texts[0]).toContain("connected after this conversation started");
		expect(texts[1]).toContain("# MCP Server Instructions");
		expect(texts[1]).toContain("## deepwiki\nUse ask_question.");
		expect(texts[2]).toContain("- gh: 401 bad token");
		expect(texts[2]).toContain("failed to connect");
		expect(texts[3]).toContain("old");
		expect(texts[3]).toContain("disconnected");
	});
});
