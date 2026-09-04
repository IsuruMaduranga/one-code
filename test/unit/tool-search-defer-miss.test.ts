import { beforeEach, describe, expect, it } from "vitest";
import { DEFER_CHANNEL } from "../../extensions/lib/deferred.ts";
import { MCP_TOOLS_CHANNEL } from "../../extensions/lib/mcp-share.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { makeToolSearchFakePi, type Reminder } from "./helpers/tool-search-fake-pi.ts";

/**
 * Integration test for the deferred-miss steering wired in tool-search/index.ts:
 * when the model calls a deferred tool directly, pi's core dispatcher fails it
 * with a bare "Tool <name> not found" tool_execution_end. We drive the real
 * extension against a fake pi and assert the one-shot correction is emitted.
 */

const makeFakePi = () => makeToolSearchFakePi();

function correctionFor(reminders: Reminder[], name: string) {
	return reminders.find((r) => r.key === `deferred-miss-${name}`);
}

describe("tool-search deferred-miss steering", () => {
	let fake: ReturnType<typeof makeFakePi>;

	beforeEach(() => {
		fake = makeFakePi();
		fake.allTools.push({ name: "web_fetch", description: "Fetch a URL." });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		toolSearchExtension(fake.pi as any);
		// Register web_fetch as deferred (as its owning extension would), then start.
		fake.pi.events.emit(DEFER_CHANNEL, { name: "web_fetch" });
		fake.setActive(["read", "web_fetch"]);
		fake.pi.fire("session_start", {});
		fake.reminders.length = 0; // drop the standing deferred-tools announce
	});

	it("steers a deferred-tool not-found error back to tool_search (one-shot)", () => {
		fake.pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "web_fetch",
			isError: true,
			result: { content: [{ type: "text", text: "Tool web_fetch not found" }] },
		});

		const correction = correctionFor(fake.reminders, "web_fetch");
		expect(correction).toBeDefined();
		expect(correction?.scope).toBe("next-turn");
		expect(correction?.text).toContain("tool_search");
		expect(correction?.text).toContain("select:web_fetch");
	});

	it("ignores a not-found error for a tool that is not deferred", () => {
		fake.pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "made_up",
			isError: true,
			result: { content: [{ type: "text", text: "Tool made_up not found" }] },
		});
		expect(correctionFor(fake.reminders, "made_up")).toBeUndefined();
		expect(fake.reminders).toHaveLength(0);
	});

	it("ignores successful results and unrelated errors", () => {
		fake.pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "web_fetch",
			isError: false,
			result: { content: [{ type: "text", text: "Tool web_fetch not found" }] },
		});
		fake.pi.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "web_fetch",
			isError: true,
			result: { content: [{ type: "text", text: "Permission required" }] },
		});
		expect(fake.reminders).toHaveLength(0);
	});
});

describe("tool-search late-defer announcements (M7)", () => {
	let fake: ReturnType<typeof makeFakePi>;
	const listings = () => fake.reminders.filter((r) => r.key === "deferred-tools");

	beforeEach(() => {
		fake = makeFakePi();
		fake.allTools.push({ name: "web_fetch", description: "Fetch a URL." });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		toolSearchExtension(fake.pi as any);
		fake.pi.events.emit(DEFER_CHANNEL, { name: "web_fetch" });
		fake.setActive(["read", "web_fetch"]);
		fake.pi.fire("session_start", {});
		fake.reminders.length = 0;
	});

	it("before any request, a late defer updates the listing (debounced into one)", async () => {
		fake.allTools.push({ name: "mcp__s__a", description: "a" }, { name: "mcp__s__b", description: "b" });
		fake.setActive(["read", "mcp__s__a", "mcp__s__b"]);
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__s__a" });
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__s__b" });
		expect(fake.pi.getActiveTools()).toEqual(["read"]);
		expect(listings()).toHaveLength(0);
		await new Promise((r) => setTimeout(r, 150));
		expect(listings()).toHaveLength(1);
		expect(listings()[0].text).toContain("mcp__s__a");
		expect(listings()[0].text).toContain("mcp__s__b");
	});

	it("after a request went out, holds the announcement until MCP settles, then sends one addendum (the listing stays frozen)", async () => {
		fake.pi.fire("context", { messages: [] });
		fake.allTools.push({ name: "mcp__s__a", description: "a" });
		fake.setActive(["read", "mcp__s__a"]);
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__s__a" });
		await new Promise((r) => setTimeout(r, 150));
		expect(fake.pi.getActiveTools()).toEqual(["read"]); // deactivated at once
		expect(fake.reminders).toHaveLength(0); // but not announced yet
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		// Message 1 is cached by now: the standing listing is never rewritten …
		expect(listings()).toHaveLength(0);
		// … the new name rides an unkeyed one-shot addendum instead (tool-search/announce.ts).
		expect(fake.reminders).toHaveLength(1);
		expect(fake.reminders[0].key).toBeUndefined();
		expect(fake.reminders[0].text).toContain("mcp__s__a");
	});
});

