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
});
