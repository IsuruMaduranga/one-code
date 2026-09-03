import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	appendReminderBlocks,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	injectReminders,
	ReminderQueue,
	tailAnchor,
	wrapReminder,
} from "../../extensions/lib/reminders.ts";

// Minimal structural stand-ins for AgentMessage
const user = (content: string | Array<{ type: string; text?: string }>, timestamp = 0) =>
	({ role: "user", content, timestamp }) as any;
const assistant = () => ({ role: "assistant", content: [], timestamp: 0 }) as any;
const toolResult = (text = "ok") =>
	({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text }], timestamp: 0 }) as any;
const compaction = (summary = "what happened", timestamp = 0) =>
	({ role: "compactionSummary", summary, tokensBefore: 1, timestamp }) as any;
const blockTexts = (m: any) => (typeof m.content === "string" ? [m.content] : m.content.map((b: any) => b.text));

const texts = (q: ReminderQueue) => q.drain().map((e) => e.text);

describe("ReminderQueue", () => {
	it("drains pending next-turn reminders once", () => {
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

	it("takeOneShots removes only the pending last-append one-shots (for the tool_result hook)", () => {
		const q = new ReminderQueue();
		q.enqueue("file changed");
		q.enqueue("ctx", { scope: "every-turn", key: "c", placement: "first-prepend" });
		q.enqueue("later", { placement: "first-prepend" });
		expect(q.hasPendingOneShots).toBe(true);
		expect(q.takeOneShots().map((e) => e.text)).toEqual(["file changed"]);
		expect(q.hasPendingOneShots).toBe(false);
		expect(texts(q)).toEqual(["ctx", "later"]);
	});

	it("pinned one-shots stay in every later drain, fixed to their anchor (retry-safe by construction)", () => {
		const q = new ReminderQueue();
		q.enqueue("file changed");
		q.pin({ kind: "toolResult", toolCallId: "c1" });
		const first = q.drain();
		expect(first).toEqual([{ text: "file changed", placement: "last-append", order: 0, pin: { kind: "toolResult", toolCallId: "c1" } }]);
		expect(q.drain()).toEqual(first);
		expect(q.size).toBe(1);
	});

	it("stamps sticky-append with `since` at enqueue and keeps it while the text is unchanged", () => {
		let now = 1000;
		const q = new ReminderQueue(() => now);
		q.enqueue("plan mode on", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		now = 2000;
		q.enqueue("plan mode on", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		expect(q.drain()[0].since).toBe(1000);
		// Different text under the same key is a new fact: anchors from now.
		q.enqueue("auto mode on", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		expect(q.drain()[0].since).toBe(2000);
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

	it("returns messages unchanged when there is nothing to anchor to", () => {
		const messages = [assistant()];
		expect(injectReminders(messages, ["x"])).toBe(messages);
	});

	it("appends a mid-turn last-append reminder to the trailing tool result, not the turn's user prompt (C1)", () => {
		const messages = [user("do it"), assistant(), toolResult("ran")];
		const result = injectReminders(messages, ["that tool is deferred"]);
		expect(blockTexts(result[0])).toEqual(["do it"]);
		expect(blockTexts(result[2])).toEqual(["ran", wrapReminder("that tool is deferred")]);
		expect(result[2].role).toBe("toolResult");
		expect((result[2] as any).toolCallId).toBe("c1");
	});

	it("sticky-append rides every user message since its anchor and none before (C2)", () => {
		const messages = [user("t1", 100), assistant(), user("t2", 200), assistant(), user("t3", 300)];
		// Switched on while turn t2 was open (stamped after t2, before t3).
		const entry = { text: "auto mode on", placement: "sticky-append" as const, order: 0, since: 250 };
		const result = injectReminders(messages, [entry]);
		expect(blockTexts(result[0])).toEqual(["t1"]);
		expect(blockTexts(result[2])).toEqual(["t2", wrapReminder("auto mode on")]);
		expect(blockTexts(result[4])).toEqual(["t3", wrapReminder("auto mode on")]);
		// Byte-stable: the same request one turn later yields the same earlier messages.
		const later = injectReminders([...messages, assistant(), user("t4", 400)], [entry]);
		expect(later.slice(0, 5)).toEqual(result);
	});

	it("sticky-append also rides the user message that opened the turn it switched on in", () => {
		// A standing reminder emitted on before_agent_start is stamped AFTER the
		// turn's user message; that message must still carry it, and keep it.
		const messages = [user("t1", 100), assistant(), toolResult("ran")];
		const entry = { text: "plan on", placement: "sticky-append" as const, order: 0, since: 150 };
		const result = injectReminders(messages, [entry]);
		expect(blockTexts(result[0])).toEqual(["t1", wrapReminder("plan on")]);
		expect(blockTexts(result[2])).toEqual(["ran"]);
		// Earlier turns stay untouched; only the opener and later turns carry it.
		const later = injectReminders([user("t0", 50), assistant(), ...messages, assistant(), user("t2", 200)], [entry]);
		expect(blockTexts(later[0])).toEqual(["t0"]);
		expect(blockTexts(later[2])).toEqual(["t1", wrapReminder("plan on")]);
		expect(blockTexts(later[6])).toEqual(["t2", wrapReminder("plan on")]);
	});

	it("a pinned one-shot rides the exact tool result or user turn it first landed on", () => {
		const messages = [user("t1", 100), assistant(), toolResult("ran"), assistant(), user("t2", 200)];
		const pinnedToResult = { text: "deferred miss", placement: "last-append" as const, order: 0, pin: { kind: "toolResult" as const, toolCallId: "c1" } };
		const pinnedToTurn = { text: "mode changed", placement: "last-append" as const, order: 0, pin: { kind: "user" as const, timestamp: 100 } };
		const result = injectReminders(messages, [pinnedToResult, pinnedToTurn]);
		expect(blockTexts(result[0])).toEqual(["t1", wrapReminder("mode changed")]);
		expect(blockTexts(result[2])).toEqual(["ran", wrapReminder("deferred miss")]);
		expect(blockTexts(result[4])).toEqual(["t2"]);
		// Anchor compacted away: the pin is simply absent, nothing else moves.
		const later = injectReminders([user("t2", 200)], [pinnedToResult, pinnedToTurn]);
		expect(blockTexts(later[0])).toEqual(["t2"]);
	});

	it("tailAnchor names the trailing tool result, else the last user-like turn", () => {
		expect(tailAnchor([user("t1", 100), assistant(), toolResult("ran")])).toEqual({ kind: "toolResult", toolCallId: "c1" });
		expect(tailAnchor([user("t1", 100), assistant(), user("t2", 200)])).toEqual({ kind: "user", timestamp: 200 });
		expect(tailAnchor([compaction("s", 5), assistant(), user("t2", 200)])).toEqual({ kind: "user", timestamp: 200 });
		expect(tailAnchor([assistant()])).toBeUndefined();
	});

	it("appendReminderBlocks adds wrapped blocks after the result's own content", () => {
		expect(appendReminderBlocks([{ type: "text", text: "ok" }], [{ text: "note", placement: "last-append", order: 0 }])).toEqual([
			{ type: "text", text: "ok" },
			{ type: "text", text: wrapReminder("note") },
		]);
	});

	it("sticky-append with no user turn at all rides the tail", () => {
		const messages = [compaction("s", 5), assistant(), toolResult("ran")];
		const result = injectReminders(messages, [{ text: "plan on", placement: "sticky-append", order: 0, since: 150 }]);
		expect(blockTexts(result[2])).toEqual(["ran", wrapReminder("plan on")]);
	});

	it("anchors the first-prepend stack to a compaction summary when no user turn survived (C7)", () => {
		const messages = [compaction("summary text", 5), assistant(), toolResult("ran")];
		const result = injectReminders(messages, [
			{ text: "claudeMd", placement: "first-prepend", order: 50 },
			"steer",
		]);
		expect(result[0].role).toBe("user");
		expect(result[0].timestamp).toBe(5);
		expect(blockTexts(result[0])).toEqual([
			wrapReminder("claudeMd"),
			`${COMPACTION_SUMMARY_PREFIX}summary text${COMPACTION_SUMMARY_SUFFIX}`,
		]);
		expect(blockTexts(result[2])).toEqual(["ran", wrapReminder("steer")]);
	});

	it("prefers the first real user message after a compaction summary for first-prepend", () => {
		const messages = [compaction(), user("next")];
		const result = injectReminders(messages, [{ text: "ctx", placement: "first-prepend", order: 0 }]);
		expect(result[0].role).toBe("user");
		expect(blockTexts(result[0])).toEqual([wrapReminder("ctx"), `${COMPACTION_SUMMARY_PREFIX}what happened${COMPACTION_SUMMARY_SUFFIX}`]);
	});

	it("reproduces pi's compaction-summary frame byte for byte", async () => {
		const pi = await import(
			pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js")).href
		);
		expect(COMPACTION_SUMMARY_PREFIX).toBe(pi.COMPACTION_SUMMARY_PREFIX);
		expect(COMPACTION_SUMMARY_SUFFIX).toBe(pi.COMPACTION_SUMMARY_SUFFIX);
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
