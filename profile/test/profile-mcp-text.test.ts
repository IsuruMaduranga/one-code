/**
 * One Code's MCP wording (profile/text/mcp/) for the texts the golden snapshot
 * cannot reach: the cut labels, the notices for a server that recovers,
 * connects late or drops, a failed refresh, and the failures and image
 * problems a stub server does not produce. The golden snapshot pins the bytes
 * of every other text.
 */
import { describe, expect, it } from "vitest";
import { mcp } from "../text/mcp/index.ts";
import { mcpResultText } from "../../extensions/tools/mcp/text.ts";

describe("One Code's MCP text", () => {
	it("labels a cut description with its full length, and cut instructions without", () => {
		expect(mcpResultText.tool.descriptionCut({ head: "abc", chars: 5000 })).toBe("abc… [truncated, 5000 chars]");
		expect(mcpResultText.instructionsCut("abc")).toBe("abc… [truncated]");
	});

	it("announces servers that recover, connect late or drop inside an epoch", () => {
		expect(mcpResultText.notices.recovered(["a"])).toBe(
			"MCP server a connected after this conversation started (an earlier notice reported a connection failure). The server's tools are available as deferred tools — load them with tool_search.",
		);
		expect(mcpResultText.notices.connected([{ name: "a", text: "Use it." }, { name: "b", text: "Or this." }])).toBe(
			"MCP servers a, b connected after this conversation started; the tools are available as deferred tools (load with tool_search). Server instructions:\n\n# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## a\nUse it.\n\n## b\nOr this.",
		);
		expect(mcpResultText.notices.dropped(["a", "b"])).toBe(
			'MCP servers a, b disconnected; their tools answer "not connected" until the server is reconnected (the user can do that in /mcp).',
		);
		expect(mcpResultText.notices.refreshFailed({ server: "a", failure: "boom" })).toBe('MCP server "a" could not refresh its tool list: boom');
	});

	it("words each failure, with the server's stderr when there is one", () => {
		expect(mcpResultText.failure({ kind: "timedOut", server: "a", step: "connect", ms: 20000, stderr: { text: "tail", cut: true } })).toBe(
			'connecting to "a" timed out after 20000ms\nserver stderr: …tail',
		);
		expect(mcpResultText.failure({ kind: "timedOut", step: "exchangeCode", ms: 20000 })).toBe("exchanging the authorization code timed out after 20000ms");
		expect(mcpResultText.failure({ kind: "closedDuringDiscovery", server: "a" })).toBe('connection to "a" closed during discovery');
		expect(mcpResultText.failure({ kind: "closedByServer", stderr: "bye" })).toBe("connection closed by the server\nserver stderr: bye");
		expect(mcpResultText.failure({ kind: "nameTooLong", tool: "t", length: 130, max: 128 })).toBe(
			'tool "t" skipped: its namespaced name is 130 characters, over the 128-character limit the provider enforces',
		);
		expect(mcpResultText.failure({ kind: "nameTaken", tool: "a.b", name: "mcp__s__a_b" })).toBe(
			'tool "a.b" skipped: its registered name "mcp__s__a_b" is already taken by another tool',
		);
		expect(mcpResultText.failure({ kind: "listFailed", list: "resourceTemplates", reason: { kind: "timedOut", server: "a", step: "listResourceTemplates", ms: 20000 } })).toBe(
			'connected, but listing resource templates failed: listing resource templates of "a" timed out after 20000ms',
		);
		expect(mcpResultText.failure({ kind: "listFailed", list: "tools", refresh: true, reason: { kind: "repeatedCursor" } })).toBe(
			"connected, but refreshing tools failed: MCP server repeated a pagination cursor; check the server's list implementation.",
		);
	});

	it("names what is wrong with an image a server sent", () => {
		const undecodable = (problem: Parameters<typeof mcpResultText.content.imageUndecodable>[0]["problem"]) => mcpResultText.content.imageUndecodable({ problem, bytes: 9 });
		expect(undecodable({ kind: "png", defect: "checksum", chunk: "IDAT" })).toBe("[image content could not be decoded: corrupt PNG (bad IDAT chunk checksum), 9 bytes]");
		expect(undecodable({ kind: "tooLarge", bytes: 9, limit: 5 })).toBe("[image content could not be decoded: image is ~9 bytes, over the 5-byte ceiling, 9 bytes]");
		expect(undecodable({ kind: "jpeg", defect: "noEnd" })).toBe("[image content could not be decoded: truncated JPEG (no end-of-image marker), 9 bytes]");
		expect(undecodable({ kind: "unrecognised" })).toBe("[image content could not be decoded: unrecognised image format (claimed none), 9 bytes]");
	});
});
