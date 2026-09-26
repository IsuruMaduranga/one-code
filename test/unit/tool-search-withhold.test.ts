import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFER_CHANNEL, deferredAddendumText, WITHHOLD_CHANNEL } from "../../extensions/lib/deferred.ts";
import { MCP_TOOLS_CHANNEL } from "../../extensions/lib/mcp-share.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { makeToolSearchFakePi, type Reminder } from "./helpers/tool-search-fake-pi.ts";

/**
 * A withheld deferred tool leaves the session's surface: not active, not in the
 * listing, not loadable. Before the first request the listing is rewritten at
 * once without it; a later re-defer (a model change) announces it again.
 */
const listings = (reminders: Reminder[]) => reminders.filter((r) => r.key === "deferred-tools");

describe("tool-search withhold", () => {
	let fake: ReturnType<typeof makeToolSearchFakePi>;
	beforeEach(() => {
		vi.useFakeTimers();
		fake = makeToolSearchFakePi();
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("web_fetch");
		fake.addDeferred("task_create");
		fake.pi.fire("session_start", {});
	});
	afterEach(() => vi.useRealTimers());

	it("rewrites the listing without the tool before the first request, synchronously", () => {
		expect(listings(fake.reminders).at(-1)?.text).toContain("task_create");
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		const last = listings(fake.reminders).at(-1)?.text ?? "";
		expect(last).toContain("web_fetch");
		expect(last).not.toContain("task_create");
		expect(fake.activeTools()).not.toContain("task_create");
	});

	it("deactivates a tool the transcript had loaded", () => {
		fake.setActive([...fake.activeTools(), "task_create"]);
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		expect(fake.activeTools()).not.toContain("task_create");
	});

	it("keeps the frozen listing after the first request, and announces a re-defer as an addendum", async () => {
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		fake.pi.fire("context", { messages: [] });
		fake.reminders.length = 0;
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		expect(listings(fake.reminders)).toHaveLength(0);

		fake.pi.events.emit(DEFER_CHANNEL, { name: "task_create" });
		await vi.advanceTimersByTimeAsync(150);
		// The frozen listing already named it, so nothing new is announced.
		expect(fake.reminders.filter((r) => r.text === deferredAddendumText(["task_create"]))).toHaveLength(0);
		expect(fake.activeTools()).not.toContain("task_create");
	});

	it("ignores a name it never deferred", () => {
		const before = fake.reminders.length;
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "bash" });
		expect(fake.reminders.length).toBe(before);
	});

	it("announces a tool withheld at start once a model change brings it back", async () => {
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		fake.pi.fire("context", { messages: [] });
		fake.pi.events.emit(DEFER_CHANNEL, { name: "task_create" });
		await vi.advanceTimersByTimeAsync(150);
		expect(fake.reminders.filter((r) => r.text === deferredAddendumText(["task_create"]))).toHaveLength(1);
	});

	it("steers a miss on a withheld tool differently from an ordinary deferred miss", () => {
		// task_create was active (addDeferred started it active); the model
		// switches models mid-session and it's withdrawn out from under it.
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		fake.reminders.length = 0;

		fake.pi.fire("tool_execution_end", {
			isError: true,
			result: { content: [{ type: "text", text: "Tool task_create not found" }] },
		});
		const withheldMiss = fake.reminders.find((r) => r.key === "deferred-miss-task_create");
		expect(withheldMiss?.text).toContain("withdrawn");
		// Must not repeat the ordinary "load it with tool_search" advice — retrying
		// through tool_search would fail again, since the name is gone from the registry.
		expect(withheldMiss?.text).not.toContain("select:task_create");

		fake.pi.fire("tool_execution_end", {
			isError: true,
			result: { content: [{ type: "text", text: "Tool web_fetch not found" }] },
		});
		const ordinaryMiss = fake.reminders.find((r) => r.key === "deferred-miss-web_fetch");
		expect(ordinaryMiss?.text).toContain("select:web_fetch");
	});

	it("reports a withheld name in a select: query as withdrawn, not misspelled", async () => {
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		const result = await fake.runTool("tool_search", { query: "select:task_create,web_fetch,task_craete" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Withdrawn for the current model (do not retry): task_create.");
		expect(text).toContain("check spelling, or search by keyword instead of `select:`): task_craete.");
		expect(text).not.toMatch(/check spelling[^.]*task_create/);
	});
});
