import { describe, expect, it } from "vitest";
import { DEFER_CHANNEL, deferredAddendumText, deferredRemovedText, WITHHOLD_CHANNEL } from "../../extensions/lib/deferred.ts";
import { requestIdentity } from "../../extensions/lib/anthropic-auth.ts";
import { makeRecord, RECORD } from "../../extensions/lib/ledger/records.ts";
import { MCP_TOOLS_CHANNEL } from "../../extensions/lib/mcp-share.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { makeToolSearchFakePi, type Reminder } from "./helpers/tool-search-fake-pi.ts";

/**
 * The deferred-tools listing is live state: what a request that opens an epoch
 * renders on message 1. Inside an epoch message 1 is the ledger's record, so a
 * tool that registered since rides the request's tail, computed when the
 * request goes out from what is loadable then minus what the epoch told
 * (extensions/ledger, lib/reminders.ts RENDER_CHANNEL).
 */

const makeFakePi = () => makeToolSearchFakePi(["read", "bash"]);
const listings = (reminders: Reminder[]) => reminders.filter((r) => r.key === "deferred-tools");
/** A first-party model that takes Claude Code's reference-form tool_addition. */
const additionsModel = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5-5", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } };

/** A branch inside an epoch on `model` whose message 1 listed `told` as deferred. */
function epochBranch(told: string[], model = additionsModel) {
	const identity = requestIdentity(model);
	if (!identity) throw new Error("no identity");
	return [
		{ type: "custom", id: "r1", parentId: null, customType: RECORD.request, data: makeRecord("request", "test", { identity, keep: 0, append: [], head: "h", blobs: { h: { system: "s", tools: [] } }, consumed: [], covers: { count: 1, role: "user", timestamp: 1 } }) },
		{ type: "custom", id: "t1", parentId: "r1", customType: RECORD.told, data: makeRecord("told", "test", { facts: [{ kind: "tools", names: told }] }) },
		{ type: "message", id: "a1", parentId: "t1", message: { role: "assistant" } },
	];
}

function mount() {
	const fake = makeFakePi();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	toolSearchExtension(fake.pi as any);
	fake.addDeferred("web_fetch");
	fake.pi.fire("session_start", {});
	return fake;
}

describe("tool-search listing and render-time addenda", () => {
	it("keeps the standing listing current with live state, with the names it tells as facts", () => {
		const fake = mount();
		fake.addDeferred("lsp_diagnostics");
		const last = listings(fake.reminders).at(-1) as Reminder & { facts?: unknown };
		expect(last.placement).toBe("first-prepend");
		expect(last.text).toContain("lsp_diagnostics");
		expect(last.facts).toEqual([{ kind: "tools", names: ["web_fetch", "lsp_diagnostics"] }]);
		expect(fake.activeTools()).not.toContain("lsp_diagnostics");
	});

	it("adds nothing to a request that opens an epoch: the listing says it all", () => {
		const fake = mount();
		fake.addDeferred("mcp__a__x");
		expect(fake.render({ epoch: true })).toEqual([]);
	});

	it("announces only what the epoch has not told, once per request that needs it", () => {
		const fake = mount();
		fake.addDeferred("mcp__a__x");
		fake.addDeferred("mcp__a__y");
		const blocks = fake.render({ told: { tools: ["web_fetch"] } });
		expect(blocks).toEqual([{ text: deferredAddendumText(["mcp__a__x", "mcp__a__y"]), facts: [{ kind: "tools", names: ["mcp__a__x", "mcp__a__y"] }] }]);
		expect(fake.render({ told: { tools: ["web_fetch", "mcp__a__x", "mcp__a__y"] } })).toEqual([]);
	});

	it("says once that a tool the epoch was told about is gone, when its absence is known", () => {
		const fake = mount();
		const goneFact = (names: string[]) => [{ kind: "tools", names, removed: true }];
		// Not yet known gone: a resume's first request goes out before a slow MCP server registers.
		expect(fake.render({ told: { tools: ["web_fetch", "mcp__gone__x", "lsp"] } })).toEqual([]);
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		// Settled: the MCP tool is gone; a non-MCP tool this process never saw (a fork's parent-only tool) is not announced.
		expect(fake.render({ told: { tools: ["web_fetch", "mcp__gone__x", "lsp"] } })).toEqual([{ text: deferredRemovedText(["mcp__gone__x"]), facts: goneFact(["mcp__gone__x"]) }]);
		// Once told gone the epoch no longer holds it told, so its return is new.
		fake.addDeferred("mcp__gone__x");
		expect(fake.render({ told: { tools: ["web_fetch", "lsp"] } })).toEqual([{ text: deferredAddendumText(["mcp__gone__x"]), facts: [{ kind: "tools", names: ["mcp__gone__x"] }] }]);
	});

	it("says a tool this process saw is gone once it leaves", () => {
		const fake = mount();
		fake.addDeferred("late_echo");
		fake.render({ told: { tools: ["web_fetch"] } });
		fake.unregister("late_echo");
		expect(fake.render({ told: { tools: ["web_fetch", "late_echo"] } })).toEqual([{ text: deferredRemovedText(["late_echo"]), facts: [{ kind: "tools", names: ["late_echo"], removed: true }] }]);
	});

	it("never announces a tool withheld before the request goes out (the H1 class)", () => {
		const fake = mount();
		fake.addDeferred("task_create");
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		expect(fake.render({ told: { tools: ["web_fetch"] } })).toEqual([]);
		expect(listings(fake.reminders).at(-1)?.text).not.toContain("task_create");
	});

	it("on a tool_addition model, activates an untold tool before the turn and announces it callable (R3-M1)", () => {
		const fake = makeFakePi();
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("web_fetch");
		const ctx = { model: additionsModel, sessionManager: { getBranch: () => epochBranch(["web_fetch"]) } };
		fake.pi.fire("session_start", {}, ctx);
		fake.addDeferred("probe_echo");
		fake.pi.fire("turn_start", {}, ctx);
		expect(fake.activeTools()).toContain("probe_echo");
		const blocks = fake.render({ told: { tools: ["web_fetch"] }, model: additionsModel });
		expect(blocks[0].facts).toEqual([{ kind: "tools", names: ["probe_echo"], callable: true }]);
	});

	it("never announces a tool callable that this turn's tools lack: one inactive now waits", () => {
		const fake = mount();
		fake.addDeferred("probe_echo");
		fake.setActive(fake.activeTools().filter((name) => name !== "probe_echo"));
		expect(fake.render({ told: { tools: ["web_fetch"] }, model: additionsModel })).toEqual([]);
	});

	it("keeps a tool the epoch listed deferred when its server connects late, so tool_search loads it (R3-H3)", async () => {
		const fake = makeFakePi();
		toolSearchExtension(fake.pi as never);
		const ctx = { model: additionsModel, sessionManager: { getBranch: () => epochBranch(["mcp__s__x"]) } };
		fake.pi.fire("session_start", {}, ctx);
		fake.addDeferred("mcp__s__x");
		expect(fake.activeTools()).not.toContain("mcp__s__x");
		const result = await fake.runTool("tool_search", { query: "select:mcp__s__x" });
		expect(result.content[0].text).toBe("Loaded mcp__s__x. These tools are now callable.");
	});

	it("keeps a deferred tool the recorded head declares eagerly callable after a /reload (R3-M2)", () => {
		const fake = makeFakePi();
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("mcp__s__x");
		const branch = epochBranch(["mcp__s__x"]);
		(branch[0].data as { blobs: Record<string, unknown> }).blobs.h = { system: "s", tools: [{ name: "mcp__s__x", input_schema: { type: "object" } }] };
		fake.pi.fire("session_start", {}, { model: additionsModel, sessionManager: { getBranch: () => branch } });
		expect(fake.activeTools()).toContain("mcp__s__x");
	});

	it("never leaves a withheld tool active after pi restores a /tree branch's loadout (R3-M3)", () => {
		const fake = mount();
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "web_fetch" });
		fake.setActive([...fake.activeTools(), "web_fetch"]);
		fake.pi.fire("session_tree", {}, { model: additionsModel, sessionManager: { getBranch: () => [] } });
		expect(fake.activeTools()).not.toContain("web_fetch");
	});

	it("says once per epoch that this run cannot load the deferred tools the epoch listed", () => {
		const fake = mount();
		fake.unregister("tool_search");
		const blocks = fake.render({ told: { tools: ["web_fetch"] } });
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain("tool_search is not available");
		expect(fake.render({ told: { tools: ["web_fetch"] }, modes: { "deferred-unavailable": true } })).toEqual([]);
	});

	it("a re-emitted defer of a told tool announces nothing new", () => {
		const fake = mount();
		fake.pi.events.emit(DEFER_CHANNEL, { name: "web_fetch", keywords: ["again"] });
		expect(fake.render({ told: { tools: ["web_fetch"] } })).toEqual([]);
	});

	it("a defer that lands after session_shutdown does nothing", () => {
		const fake = mount();
		fake.pi.fire("session_shutdown", { reason: "new" });
		fake.reminders.length = 0;
		fake.addDeferred("mcp__late__tool");
		expect(listings(fake.reminders)).toHaveLength(0);
	});
});
