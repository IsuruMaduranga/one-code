import { describe, expect, it } from "vitest";
import { injectReminders, ReminderQueue, wrapReminder } from "../../extensions/lib/reminders.ts";

// Minimal structural stand-ins for AgentMessage
const user = (content: string | Array<{ type: string; text?: string }>) =>
	({ role: "user", content, timestamp: 0 }) as any;
const assistant = () => ({ role: "assistant", content: [], timestamp: 0 }) as any;

const texts = (q: ReminderQueue) => q.drain().map((e) => e.text);

describe("ReminderQueue", () => {
	it("drains next-turn reminders once", () => {
		const q = new ReminderQueue();
		q.enqueue("a");
		q.enqueue("b");
		expect(texts(q)).toEqual(["a", "b"]);
		expect(texts(q)).toEqual([]);
	});

	it("keeps every-turn reminders across drains until removed", () => {
		const q = new ReminderQueue();
		q.enqueue("persistent", { scope: "every-turn", key: "k" });
		q.enqueue("once");
		expect(texts(q)).toEqual(["persistent", "once"]);
		expect(texts(q)).toEqual(["persistent"]);
		q.remove("k");
		expect(texts(q)).toEqual([]);
	});

	it("replaces every-turn reminders with the same key", () => {
		const q = new ReminderQueue();
		q.enqueue("v1", { scope: "every-turn", key: "k" });
		q.enqueue("v2", { scope: "every-turn", key: "k" });
		expect(texts(q)).toEqual(["v2"]);
	});

	it("replaces keyed next-turn reminders, keeping the latest in queue order", () => {
		const q = new ReminderQueue();
		q.enqueue("mode is acceptEdits", { key: "mode" });
		q.enqueue("unrelated");
		q.enqueue("mode is plan", { key: "mode" });
		expect(texts(q)).toEqual(["unrelated", "mode is plan"]);
	});

	it("ignores empty text", () => {
		const q = new ReminderQueue();
		q.enqueue("  ");
		expect(q.size).toBe(0);
	});

	it("carries placement and order through drain (defaults to last-append/0)", () => {
		const q = new ReminderQueue();
		q.enqueue("plain");
		q.enqueue("ctx", { scope: "every-turn", key: "c", placement: "first-prepend", order: 4 });
		expect(q.drain()).toEqual([
			{ text: "ctx", placement: "first-prepend", order: 4 },
			{ text: "plain", placement: "last-append", order: 0 },
		]);
	});
});

describe("injectReminders", () => {
	it("appends reminder blocks to the last user message with string content", () => {
		const messages = [user("hello"), assistant()];
		const result = injectReminders(messages, ["be careful"]);
		const injected = result[0] as any;
		expect(injected.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "text", text: wrapReminder("be careful") },
		]);
	});

	it("targets the LAST user message and preserves array content", () => {
		const messages = [user("first"), assistant(), user([{ type: "text", text: "second" }])];
		const result = injectReminders(messages, ["note"]);
		expect((result[0] as any).content).toBe("first");
		expect((result[2] as any).content).toHaveLength(2);
		expect((result[2] as any).content[1].text).toContain("<system-reminder>");
	});

	it("does not mutate the input messages", () => {
		const original = user("hello");
		const messages = [original];
		injectReminders(messages, ["x"]);
		expect(original.content).toBe("hello");
	});

	it("returns messages unchanged when there is no user message", () => {
		const messages = [assistant()];
		expect(injectReminders(messages, ["x"])).toBe(messages);
	});

	it("returns messages unchanged for empty reminders", () => {
		const messages = [user("hi")];
		expect(injectReminders(messages, [])).toBe(messages);
	});

	it("prepends first-prepend reminders (sorted by order) before the user text", () => {
		const messages = [user("hi")];
		const result = injectReminders(messages, [
			{ text: "claudeMd", placement: "first-prepend", order: 50 },
			{ text: "deferred", placement: "first-prepend", order: 10 },
			{ text: "mcp", placement: "first-prepend", order: 30 },
		]);
		expect((result[0] as any).content.map((b: any) => b.text)).toEqual([
			wrapReminder("deferred"),
			wrapReminder("mcp"),
			wrapReminder("claudeMd"),
			"hi",
		]);
	});

	it("prepends first-prepend to the FIRST user message and appends last-append to the LAST", () => {
		const messages = [user("first"), assistant(), user([{ type: "text", text: "second" }])];
		const result = injectReminders(messages, [
			{ text: "ctx", placement: "first-prepend", order: 0 },
			{ text: "steer", placement: "last-append", order: 0 },
		]);
		expect((result[0] as any).content.map((b: any) => b.text)).toEqual([wrapReminder("ctx"), "first"]);
		expect((result[2] as any).content.map((b: any) => b.text)).toEqual(["second", wrapReminder("steer")]);
	});

	it("on a single user message, prepends firsts and appends lasts around the text", () => {
		const messages = [user("hi")];
		const result = injectReminders(messages, [
			{ text: "ctx", placement: "first-prepend", order: 0 },
			{ text: "steer", placement: "last-append", order: 0 },
		]);
		expect((result[0] as any).content.map((b: any) => b.text)).toEqual([
			wrapReminder("ctx"),
			"hi",
			wrapReminder("steer"),
		]);
	});
});
