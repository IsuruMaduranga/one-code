import { describe, expect, it } from "vitest";
import type { ToldFact } from "../../extensions/lib/ledger/records.ts";
import { mcpChangeNotices, mcpDelta, mcpFacts, type McpSnapshot, mcpStartupNotices } from "../../extensions/mcp/announce.ts";

/** What an epoch has told, as the ledger folds it: the latest hash per whole-text block key. */
type Told = Map<string, string>;
const tell = (told: Told, facts: readonly ToldFact[]) => {
	for (const fact of facts) if (fact.kind === "block") told.set(fact.key, fact.hash);
	return told;
};
/** Told by a message 1 rendered from `snapshot`. */
const toldBy = (snapshot: McpSnapshot): Told => tell(new Map(), mcpFacts(snapshot));
/** The delta, with what announcing it tells folded into `told`. */
const announce = (told: Told, snapshot: McpSnapshot) => {
	const delta = mcpDelta(told, snapshot);
	tell(told, delta.facts);
	return delta;
};
const nothing = { newInstructions: [], newFailures: [], recovered: [], dropped: [] };
const changes = (delta: ReturnType<typeof mcpDelta>) => ({ newInstructions: delta.newInstructions, newFailures: delta.newFailures, recovered: delta.recovered, dropped: delta.dropped });

describe("mcpFacts", () => {
	it("tells the instructed and failed servers a message 1 describes, so the same state is no change", () => {
		const snapshot = { connected: [{ name: "a", instructions: "x" }, { name: "quiet" }], failed: [{ name: "gh", error: "401" }] };
		expect(changes(mcpDelta(toldBy(snapshot), { connected: [{ name: "a", instructions: "x" }], failed: [{ name: "gh", error: "401" }] }))).toEqual(nothing);
	});
});

describe("mcpDelta", () => {
	it("tells one failure per server, so two kept errors do not alternate request to request", () => {
		const told = toldBy({ connected: [], failed: [] });
		const snapshot = { connected: [], failed: [{ name: "gh", error: "401" }, { name: "gh", error: "timeout" }] };
		const first = announce(told, snapshot);
		expect(first.newFailures).toEqual([{ name: "gh", error: "timeout" }]);
		expect(changes(announce(told, snapshot))).toEqual(nothing);
	});

	it("does not report a server dropped while its reconnect is in flight", () => {
		const told = toldBy({ connected: [{ name: "a", instructions: "x" }], failed: [] });
		expect(mcpDelta(told, { connected: [], failed: [] }, false, new Set(["a"])).dropped).toEqual([]);
		expect(mcpDelta(told, { connected: [], failed: [] }).dropped).toEqual(["a"]);
	});

	it("reports a newly connected server's instructions once", () => {
		const told: Told = new Map();
		const delta = announce(told, { connected: [{ name: "deepwiki", instructions: "Use ask_question." }, { name: "quiet" }], failed: [] });
		expect(delta.newInstructions).toEqual([{ name: "deepwiki", instructions: "Use ask_question." }]);
		expect(delta.newFailures).toEqual([]);
		expect(changes(mcpDelta(told, { connected: [{ name: "deepwiki", instructions: "Use ask_question." }], failed: [] }))).toEqual(nothing);
	});

	it("reports a failure once per distinct error, and recovery when the server comes back", () => {
		const told: Told = new Map();
		expect(announce(told, { connected: [], failed: [{ name: "gh", error: "401" }] }).newFailures).toEqual([{ name: "gh", error: "401" }]);
		expect(announce(told, { connected: [], failed: [{ name: "gh", error: "401" }] }).newFailures).toEqual([]);
		expect(announce(told, { connected: [], failed: [{ name: "gh", error: "timeout" }] }).newFailures).toEqual([{ name: "gh", error: "timeout" }]);
		expect(announce(told, { connected: [{ name: "gh" }], failed: [] }).recovered).toEqual(["gh"]);
		expect(changes(mcpDelta(told, { connected: [{ name: "gh" }], failed: [] }))).toEqual(nothing);
	});

	it("reports an instructed server that vanished without a failure record as dropped, once", () => {
		const told: Told = new Map();
		announce(told, { connected: [{ name: "a", instructions: "x" }], failed: [] });
		expect(announce(told, { connected: [], failed: [] }).dropped).toEqual(["a"]);
		expect(changes(mcpDelta(told, { connected: [], failed: [] }))).toEqual(nothing);
	});

	it("a server that reconnects with different instructions is re-announced with the new text", () => {
		const told: Told = new Map();
		announce(told, { connected: [{ name: "a", instructions: "old text" }], failed: [] });
		// It dies (a failure, so not "dropped") …
		announce(told, { connected: [], failed: [{ name: "a", error: "connection closed by the server" }] });
		// … and comes back after an upgrade with new instructions.
		const delta = announce(told, { connected: [{ name: "a", instructions: "new text" }], failed: [] });
		expect(delta.recovered).toEqual(["a"]);
		expect(delta.newInstructions).toEqual([{ name: "a", instructions: "new text" }]);
		// Same text again: nothing new to say.
		expect(mcpDelta(told, { connected: [{ name: "a", instructions: "new text" }], failed: [] }).newInstructions).toEqual([]);
	});

	it("a server that closed is a new failure, not a drop", () => {
		const told: Told = new Map();
		announce(told, { connected: [{ name: "a", instructions: "x" }], failed: [] });
		const delta = mcpDelta(told, { connected: [], failed: [{ name: "a", error: "connection closed by the server" }] });
		expect(delta.dropped).toEqual([]);
		expect(delta.newFailures).toEqual([{ name: "a", error: "connection closed by the server" }]);
	});

	it("does not reannounce changes outside the instruction and failure text shown to the model", () => {
		const told = toldBy({
			connected: [{ name: "a", instructions: `${"a".repeat(3_000)} hidden old suffix` }],
			failed: [{ name: "bad", error: `${"x".repeat(300)}\nhidden old diagnostics` }],
		});
		expect(changes(mcpDelta(told, {
			connected: [{ name: "a", instructions: `${"a".repeat(3_000)} hidden new suffix` }],
			failed: [{ name: "bad", error: `${"x".repeat(300)}\nhidden new diagnostics` }],
		}))).toEqual(nothing);
	});
});

describe("mcpChangeNotices", () => {
	it("is empty when nothing changed", () => {
		expect(mcpChangeNotices({ ...nothing, facts: [] })).toEqual([]);
	});

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
