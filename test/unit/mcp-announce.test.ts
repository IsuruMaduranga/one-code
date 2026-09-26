import { describe, expect, it } from "vitest";
import { announcedFrom, applyMcpDelta, emptyAnnounced, mcpChangeNotices, mcpDelta, mcpStartupNotices } from "../../extensions/mcp/announce.ts";

describe("announcedFrom", () => {
	it("records the instructed and failed servers a fresh message 1 describes", () => {
		const announced = announcedFrom({
			connected: [{ name: "a", instructions: "x" }, { name: "quiet" }],
			failed: [{ name: "gh", error: "401" }],
		});
		expect([...announced.instructed]).toEqual([["a", "x"]]);
		expect([...announced.failed]).toEqual([["gh", "401"]]);
		expect(mcpDelta(announced, { connected: [{ name: "a", instructions: "x" }], failed: [{ name: "gh", error: "401" }] })).toEqual({
			newInstructions: [],
			newFailures: [],
			recovered: [],
			dropped: [],
		});
	});
});

describe("mcpDelta", () => {
	it("reports a newly connected server's instructions once", () => {
		const announced = emptyAnnounced();
		const delta = mcpDelta(announced, {
			connected: [{ name: "deepwiki", instructions: "Use ask_question." }, { name: "quiet" }],
			failed: [],
		});
		expect(delta.newInstructions).toEqual([{ name: "deepwiki", instructions: "Use ask_question." }]);
		expect(delta.newFailures).toEqual([]);
		applyMcpDelta(announced, delta);
		expect(mcpDelta(announced, { connected: [{ name: "deepwiki", instructions: "Use ask_question." }], failed: [] })).toEqual({
			newInstructions: [],
			newFailures: [],
			recovered: [],
			dropped: [],
		});
	});

	it("reports a failure once per distinct error, and recovery when the server comes back", () => {
		const announced = emptyAnnounced();
		let delta = mcpDelta(announced, { connected: [], failed: [{ name: "gh", error: "401" }] });
		expect(delta.newFailures).toEqual([{ name: "gh", error: "401" }]);
		applyMcpDelta(announced, delta);

		delta = mcpDelta(announced, { connected: [], failed: [{ name: "gh", error: "401" }] });
		expect(delta.newFailures).toEqual([]);

		delta = mcpDelta(announced, { connected: [], failed: [{ name: "gh", error: "timeout" }] });
		expect(delta.newFailures).toEqual([{ name: "gh", error: "timeout" }]);
		applyMcpDelta(announced, delta);

		delta = mcpDelta(announced, { connected: [{ name: "gh" }], failed: [] });
		expect(delta.recovered).toEqual(["gh"]);
		applyMcpDelta(announced, delta);
		expect(announced.failed.size).toBe(0);
	});

	it("reports an instructed server that vanished without a failure record as dropped", () => {
		const announced = emptyAnnounced();
		applyMcpDelta(announced, mcpDelta(announced, { connected: [{ name: "a", instructions: "x" }], failed: [] }));
		const delta = mcpDelta(announced, { connected: [], failed: [] });
		expect(delta.dropped).toEqual(["a"]);
		applyMcpDelta(announced, delta);
		expect(announced.instructed.size).toBe(0);
	});

	it("a server that reconnects with different instructions is re-announced with the new text", () => {
		const announced = emptyAnnounced();
		applyMcpDelta(announced, mcpDelta(announced, { connected: [{ name: "a", instructions: "old text" }], failed: [] }));
		// It dies (a failure, so not "dropped") …
		applyMcpDelta(announced, mcpDelta(announced, { connected: [], failed: [{ name: "a", error: "connection closed by the server" }] }));
		// … and comes back after an upgrade with new instructions.
		const delta = mcpDelta(announced, { connected: [{ name: "a", instructions: "new text" }], failed: [] });
		expect(delta.recovered).toEqual(["a"]);
		expect(delta.newInstructions).toEqual([{ name: "a", instructions: "new text" }]);
		applyMcpDelta(announced, delta);
		expect(announced.instructed.get("a")).toBe("new text");
		// Same text again: nothing new to say.
		expect(mcpDelta(announced, { connected: [{ name: "a", instructions: "new text" }], failed: [] }).newInstructions).toEqual([]);
	});

	it("a server that closed is a new failure, not a drop", () => {
		const announced = emptyAnnounced();
		applyMcpDelta(announced, mcpDelta(announced, { connected: [{ name: "a", instructions: "x" }], failed: [] }));
		const delta = mcpDelta(announced, { connected: [], failed: [{ name: "a", error: "connection closed by the server" }] });
		expect(delta.dropped).toEqual([]);
		expect(delta.newFailures).toEqual([{ name: "a", error: "connection closed by the server" }]);
	});
});

describe("mcpChangeNotices", () => {
	it("is empty when nothing changed", () => {
		expect(mcpChangeNotices({ newInstructions: [], newFailures: [], recovered: [], dropped: [] })).toEqual([]);
	});

	it("renders one notice per kind of change, instructions in Claude Code's frame", () => {
		const notices = mcpChangeNotices({
			newInstructions: [{ name: "deepwiki", instructions: "Use ask_question." }],
			newFailures: [{ name: "gh", error: "401 bad token" }],
			recovered: ["ctx7"],
			dropped: ["old"],
		});
		expect(notices).toHaveLength(4);
		expect(notices[0]).toContain("ctx7");
		expect(notices[0]).toContain("connected after this conversation started");
		expect(notices[1]).toContain("# MCP Server Instructions");
		expect(notices[1]).toContain("## deepwiki\nUse ask_question.");
		expect(notices[2]).toContain("- gh: 401 bad token");
		expect(notices[2]).toContain("failed to connect");
		expect(notices[3]).toContain("old");
		expect(notices[3]).toContain("disconnected");
	});
});

describe("mcpStartupNotices", () => {
	it("is one line per kind of problem, in Claude Code's words", () => {
		expect(mcpStartupNotices(2, 0)).toEqual(["2 MCP servers failed · /mcp"]);
		expect(mcpStartupNotices(1, 1)).toEqual(["1 MCP server failed · /mcp", "1 MCP server needs auth · /mcp"]);
		expect(mcpStartupNotices(0, 3)).toEqual(["3 MCP servers need auth · /mcp"]);
	});

	it("says nothing when every server connected", () => {
		expect(mcpStartupNotices(0, 0)).toEqual([]);
	});
});
