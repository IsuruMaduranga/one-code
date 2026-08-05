import { describe, expect, it } from "vitest";
import { injectReminders, ReminderQueue, wrapReminder } from "../../extensions/lib/reminders.ts";

// Minimal structural stand-ins for AgentMessage
const user = (content: string | Array<{ type: string; text?: string }>) =>
	({ role: "user", content, timestamp: 0 }) as any;
const assistant = () => ({ role: "assistant", content: [], timestamp: 0 }) as any;

describe("ReminderQueue", () => {
	it("drains next-turn reminders once", () => {
		const q = new ReminderQueue();
		q.enqueue("a");
		q.enqueue("b");
		expect(q.drain()).toEqual(["a", "b"]);
		expect(q.drain()).toEqual([]);
	});

	it("keeps every-turn reminders across drains until removed", () => {
		const q = new ReminderQueue();
		q.enqueue("persistent", { scope: "every-turn", key: "k" });
		q.enqueue("once");
		expect(q.drain()).toEqual(["persistent", "once"]);
		expect(q.drain()).toEqual(["persistent"]);
		q.remove("k");
		expect(q.drain()).toEqual([]);
	});

	it("replaces every-turn reminders with the same key", () => {
		const q = new ReminderQueue();
		q.enqueue("v1", { scope: "every-turn", key: "k" });
		q.enqueue("v2", { scope: "every-turn", key: "k" });
		expect(q.drain()).toEqual(["v2"]);
	});

	it("ignores empty text", () => {
		const q = new ReminderQueue();
		q.enqueue("  ");
		expect(q.size).toBe(0);
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
});
