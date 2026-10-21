import { beforeEach, describe, expect, it } from "vitest";
import { DEFER_CHANNEL, deferredAddendumText, WITHHOLD_CHANNEL } from "../../extensions/lib/deferred.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { makeToolSearchFakePi, type Reminder } from "./helpers/tool-search-fake-pi.ts";

/**
 * A withheld deferred tool leaves the session's surface: not active, not in the
 * live listing, not loadable, never announced. A later re-defer (a model
 * change) announces it at the next request unless the epoch already told it.
 */
const listings = (reminders: Reminder[]) => reminders.filter((r) => r.key === "deferred-tools");

describe("tool-search withhold", () => {
	let fake: ReturnType<typeof makeToolSearchFakePi>;
	beforeEach(() => {
		fake = makeToolSearchFakePi();
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("web_fetch");
		fake.addDeferred("task_create");
		fake.pi.fire("session_start", {});
	});
	it("updates the live listing without the tool, synchronously", () => {
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

	it("announces nothing for a re-defer of a tool the epoch already told", () => {
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		fake.pi.events.emit(DEFER_CHANNEL, { name: "task_create" });
		expect(fake.render({ told: { tools: ["web_fetch", "task_create"] } })).toEqual([]);
		expect(fake.activeTools()).not.toContain("task_create");
	});

	it("ignores a name it never deferred", () => {
		const before = fake.reminders.length;
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "bash" });
		expect(fake.reminders.length).toBe(before);
	});

	it("announces a tool withheld at start once a model change brings it back", () => {
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		expect(fake.render({ told: { tools: ["web_fetch"] } })).toEqual([]);
		fake.pi.events.emit(DEFER_CHANNEL, { name: "task_create" });
		expect(fake.render({ told: { tools: ["web_fetch"] } }).map((block) => block.text)).toEqual([deferredAddendumText(["task_create"])]);
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

	it("answers a select: of an already-callable tool as already loaded, not missing", async () => {
		fake.setActive([...fake.pi.getActiveTools(), "ask_user_question"]);
		const eager = await fake.runTool("tool_search", { query: "select:ask_user_question" });
		expect((eager as { isError?: boolean }).isError).toBeUndefined();
		expect(eager.content[0]?.text).toBe("Already loaded: ask_user_question.");
		const mixed = await fake.runTool("tool_search", { query: "select:ask_user_question,web_fetch,web_fecth" });
		const text = mixed.content[0]?.text ?? "";
		expect(text).toContain("web_fetch");
		expect(text).toContain("ask_user_question");
		expect(text).toContain("check spelling, or search by keyword instead of `select:`): web_fecth.");
		expect(text).not.toMatch(/check spelling[^.]*ask_user_question/);
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
