import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFER_CHANNEL, deferralEnabled, loaderUnavailableReminderText, WITHHOLD_CHANNEL } from "../../extensions/lib/deferred.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { makeToolSearchFakePi } from "./helpers/tool-search-fake-pi.ts";

/**
 * A `--tools` list that leaves out tool_search unregisters it, while pi 1.0.4+
 * keeps the `mcp__*` tools registered: nothing could load a deferred tool, so
 * none is deferred, listed or sent as a `defer_loading` definition.
 */
describe("deferralEnabled", () => {
	it("is true only when tool_search is registered", () => {
		expect(deferralEnabled([{ name: "read" }, { name: "tool_search" }])).toBe(true);
		expect(deferralEnabled([{ name: "read" }, { name: "mcp__s__t" }])).toBe(false);
		expect(deferralEnabled([])).toBe(false);
	});
});

describe("tool-search without its own registration", () => {
	let fake: ReturnType<typeof makeToolSearchFakePi>;
	beforeEach(() => {
		vi.useFakeTimers();
		fake = makeToolSearchFakePi(["read", "bash"]);
		fake.allTools.push({ name: "read", description: "read" }, { name: "bash", description: "bash" });
		toolSearchExtension(fake.pi as never);
		// pi filters tool_search out of the registry under `--tools read,bash`.
		fake.unregister("tool_search");
		fake.addDeferred("mcp__fixture__lookup_ticket");
		fake.pi.fire("session_start", {});
	});
	afterEach(() => vi.useRealTimers());

	it("lists nothing and leaves the active set as pi built it", () => {
		expect(fake.reminders.filter((r) => r.key === "deferred-tools" && r.text)).toHaveLength(0);
		expect(fake.activeTools()).toEqual(["read", "bash", "mcp__fixture__lookup_ticket"]);
	});

	it("neither deactivates nor announces a tool deferred after session start", async () => {
		fake.allTools.push({ name: "mcp__fixture__late", description: "late" });
		fake.setActive([...fake.activeTools(), "mcp__fixture__late"]);
		fake.reminders.length = 0;
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__fixture__late" });
		await vi.advanceTimersByTimeAsync(150);
		expect(fake.activeTools()).toContain("mcp__fixture__late");
		expect(fake.reminders).toHaveLength(0);
		expect(fake.render({ told: { tools: ["mcp__fixture__lookup_ticket"] }, modes: { "deferred-unavailable": true } })).toEqual([]);
	});

	it("keeps a withheld tool inactive when a branch switch restores a loadout that held it", () => {
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "mcp__fixture__lookup_ticket" });
		expect(fake.activeTools()).toEqual(["read", "bash"]);
		// pi restores the selected branch's tools, from before the tool was withheld.
		fake.setActive(["read", "bash", "mcp__fixture__lookup_ticket"]);
		fake.pi.fire("session_tree", {}, { sessionManager: { getBranch: () => [] } });
		expect(fake.activeTools()).toEqual(["read", "bash"]);
	});

	it("sends an Anthropic request without defer_loading definitions", () => {
		const payload = { model: "claude-opus-5-5", system: [], messages: [{ role: "user", content: "hi" }], tools: [{ name: "read" }, { name: "bash" }] };
		const ctx = { model: { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" } };
		expect(fake.pi.fire("before_provider_request", { payload }, ctx)).toEqual([undefined]);
		// The same request with tool_search registered gains the deferred definition.
		fake.allTools.push({ name: "tool_search", description: "" });
		const [withLoader] = fake.pi.fire("before_provider_request", { payload }, ctx) as Array<{ tools: Array<{ name: string; defer_loading?: boolean }> }>;
		expect(withLoader.tools.find((t) => t.name === "mcp__fixture__lookup_ticket")?.defer_loading).toBe(true);
	});
});

describe("a resumed session without tool_search", () => {
	it("says once per epoch that the tools its first message lists cannot be loaded, and never steers to tool_search", () => {
		const fake = makeToolSearchFakePi(["read", "bash"]);
		fake.allTools.push({ name: "read", description: "read" }, { name: "bash", description: "bash" });
		toolSearchExtension(fake.pi as never);
		fake.unregister("tool_search");
		fake.addDeferred("mcp__fixture__lookup_ticket");
		fake.pi.fire("session_start", {});
		// The epoch's first message listed a deferred MCP tool.
		const blocks = fake.render({ told: { tools: ["mcp__fixture__lookup_ticket"] } });
		expect(blocks).toEqual([{ text: loaderUnavailableReminderText(), facts: [{ kind: "mode", key: "deferred-unavailable", on: true }] }]);
		fake.pi.fire("tool_execution_end", { isError: true, result: { content: [{ type: "text", text: "Tool mcp__fixture__lookup_ticket not found" }] } });
		expect(fake.reminders.filter((r) => String(r.key).startsWith("deferred-miss"))).toHaveLength(0);
	});
});

describe("tool_search when pi declines to activate a tool", () => {
	it("reports the tool as not loadable instead of loaded (pi 1.1.0, `--tools read,bash,tool_search`)", async () => {
		const fake = makeToolSearchFakePi(["read", "bash"]);
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("mcp__fixture__lookup_ticket");
		fake.addDeferred("web_fetch");
		fake.pi.fire("session_start", {});
		// pi drops an MCP tool the allowlist never named from any active set.
		fake.pi.setActiveTools = (names: string[]) => {
			fake.setActive(names.filter((name) => !name.startsWith("mcp__")));
		};

		const refusedOnly = await fake.runTool("tool_search", { query: "select:mcp__fixture__lookup_ticket" });
		expect(refusedOnly.content[0].text).toBe(
			"Could not load mcp__fixture__lookup_ticket: this session's tool list (pi's --tools) leaves them out, so they cannot be called.",
		);
		expect((refusedOnly as { isError?: boolean }).isError).toBe(true);
		expect(refusedOnly.details).toMatchObject({ added: [], refused: ["mcp__fixture__lookup_ticket"] });

		const mixed = await fake.runTool("tool_search", { query: "select:web_fetch,mcp__fixture__lookup_ticket" });
		expect(mixed.content[0].text).toMatch(/^Loaded web_fetch\. These tools are now callable\. Could not load mcp__fixture__lookup_ticket:/);
		expect((mixed as { isError?: boolean }).isError).toBe(false);
		expect(fake.activeTools()).toContain("web_fetch");
	});
});
