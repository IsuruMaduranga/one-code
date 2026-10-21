import { describe, expect, it } from "vitest";
import { DEFER_CHANNEL, deferredAddendumText, WITHHOLD_CHANNEL } from "../../extensions/lib/deferred.ts";
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

	it("never announces a tool withheld before the request goes out (the H1 class)", () => {
		const fake = mount();
		fake.addDeferred("task_create");
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		expect(fake.render({ told: { tools: ["web_fetch"] } })).toEqual([]);
		expect(listings(fake.reminders).at(-1)?.text).not.toContain("task_create");
	});

	it("on a tool_addition model the addendum says the tools are callable, and makes them so", () => {
		const fake = mount();
		fake.addDeferred("probe_echo");
		fake.setActive(fake.activeTools().filter((name) => name !== "probe_echo"));
		const blocks = fake.render({ told: { tools: ["web_fetch"] }, model: additionsModel });
		expect(blocks[0].facts).toEqual([{ kind: "tools", names: ["probe_echo"], callable: true }]);
		expect(fake.activeTools()).toContain("probe_echo");
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
