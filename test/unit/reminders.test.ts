import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	appendReminderBlocks,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	injectReminders,
	openingUserAnchor,
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

const texts = (q: ReminderQueue) => q.drain([]).map((e) => e.text);

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
		expect(q.drain([])).toEqual([
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
		const messages = [user("go"), assistant(), toolResult()];
		const first = q.drain(messages);
		expect(first).toEqual([{ text: "file changed", placement: "last-append", order: 0, pin: { kind: "toolResult", toolCallId: "c1" } }]);
		expect(q.drain(messages)).toEqual(first);
		expect(q.size).toBe(1);
	});

	it("drain drops only the pins whose anchor left the context; there is no count cap", () => {
		const q = new ReminderQueue();
		for (let i = 0; i < 1000; i++) {
			q.enqueue(`note ${i}`);
			q.pin({ kind: "user", timestamp: i });
		}
		expect(q.size).toBe(1000);
		// Every anchor still present: nothing is evicted, however many there are.
		q.drain(Array.from({ length: 1000 }, (_, i) => user(`t${i}`, i)));
		expect(q.size).toBe(1000);
		// Compaction replaced the first 990 turns with a summary: exactly those pins go.
		const after = q.drain([compaction("summary", 5000), ...Array.from({ length: 10 }, (_, i) => user(`t${990 + i}`, 990 + i))]);
		expect(q.size).toBe(10);
		expect(after.map((r) => r.text)).toEqual(Array.from({ length: 10 }, (_, i) => `note ${990 + i}`));
	});

	it("stamps sticky-append with `since` at enqueue and keeps it while the text is unchanged", () => {
		let now = 1000;
		const q = new ReminderQueue(() => now);
		q.enqueue("plan mode on", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		now = 2000;
		q.enqueue("plan mode on", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		expect(q.drain([])[0].since).toBe(1000);
		// Different text under the same key is a new fact: anchors from now.
		q.enqueue("auto mode on", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		expect(q.drain([])[0].since).toBe(2000);
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

describe("custom (harness) messages are anchors (STEERING-REVIEW-2026-09-05 H1)", () => {
	const custom = (text: string, timestamp = 0) =>
		({ role: "custom", customType: "task-notification", content: [{ type: "text", text }], display: true, timestamp }) as any;

	it("prepends the context stack to a request whose only user-like message is a notification", () => {
		const messages = [custom("SYSTEM NOTIFICATION — loop tick", 7)];
		const result = injectReminders(messages, [{ text: "claudeMd", placement: "first-prepend", order: 50 }]);
		expect(result[0].role).toBe("custom");
		expect(blockTexts(result[0])).toEqual([wrapReminder("claudeMd"), "SYSTEM NOTIFICATION — loop tick"]);
	});

	it("pins a pending one-shot to the notification that opened the turn, not the earlier user message", () => {
		const messages = [user("hi", 1), assistant(), custom("agent report", 9)];
		expect(tailAnchor(messages)).toEqual({ kind: "user", timestamp: 9 });
		const result = injectReminders(messages, [{ text: "mode changed", placement: "last-append", order: 0, pin: { kind: "user", timestamp: 9 } }]);
		expect(blockTexts(result[0])).toEqual(["hi"]);
		expect(blockTexts(result[2])).toEqual(["agent report", wrapReminder("mode changed")]);
	});

	it("sticky-append rides notification messages too (they are user turns on the wire)", () => {
		const messages = [user("hi", 1), assistant(), custom("agent report", 9)];
		const result = injectReminders(messages, [{ text: "auto on", placement: "sticky-append", order: 0, since: 0 }]);
		expect(blockTexts(result[0])).toEqual(["hi", wrapReminder("auto on")]);
		expect(blockTexts(result[2])).toEqual(["agent report", wrapReminder("auto on")]);
	});

	it("drain keeps a pin anchored to a notification while that message is in context", () => {
		const q = new ReminderQueue(() => 5);
		q.enqueue("one-shot");
		q.pin({ kind: "user", timestamp: 9 });
		expect(q.drain([custom("report", 9)]).map((e) => e.text)).toEqual(["one-shot"]);
		expect(q.drain([user("other", 1)])).toEqual([]);
	});
});

describe("one-shot delivery guarantees (C3)", () => {
	it("a pinned one-shot is injected identically on every later request, including a retried attempt", () => {
		const q = new ReminderQueue();
		q.enqueue("deferred-tool miss", { placement: "last-append" });
		q.pin({ kind: "toolResult", toolCallId: "c1" });
		const messages = [user("do it"), assistant(), toolResult("ran")];
		const attempt1 = injectReminders(messages, q.drain(messages));
		// A 529/overloaded retry re-runs the context event with the same messages.
		const attempt2 = injectReminders(messages, q.drain(messages));
		expect(attempt2).toEqual(attempt1);
		expect(blockTexts(attempt1[2])).toEqual(["ran", wrapReminder("deferred-tool miss")]);
	});

	it("takeOneShots hands over only last-append one-shots, leaving state and context reminders queued", () => {
		const q = new ReminderQueue();
		q.enqueue("one-shot", { placement: "last-append" });
		q.enqueue("mode on", { placement: "sticky-append", scope: "every-turn", key: "mode" });
		q.enqueue("claudeMd", { placement: "first-prepend" });
		expect(q.takeOneShots().map((e) => e.text)).toEqual(["one-shot"]);
		expect(q.hasPendingOneShots).toBe(false);
		expect(q.drain([]).map((e) => e.text).sort()).toEqual(["claudeMd", "mode on"]);
	});

	it("a raw entry is injected without the system-reminder frame", () => {
		const messages = [user("do it"), assistant(), toolResult("ran")];
		const result = injectReminders(messages, [{ text: "<total_tokens>5 tokens left</total_tokens>", placement: "last-append", order: 0, raw: true }]);
		expect(blockTexts(result[2])).toEqual(["ran", "<total_tokens>5 tokens left</total_tokens>"]);
	});
});

describe("user-prepend (local-command breadcrumbs)", () => {
	const brief = (q: ReminderQueue) => q.enqueue("<cmd>", { placement: "user-prepend", raw: true });

	it("stays queued through a drain until pinned to a user message", () => {
		const q = new ReminderQueue();
		brief(q);
		expect(q.hasPending("user-prepend")).toBe(true);
		expect(q.drain([toolResult()]).map((e) => e.text)).toEqual([]);
		expect(q.hasPending("user-prepend")).toBe(true);
		q.pin({ kind: "user", timestamp: 7 }, "user-prepend");
		expect(q.hasPending("user-prepend")).toBe(false);
		const drained = q.drain([user("hi", 7)]);
		expect(drained.map((e) => [e.text, e.placement, e.pin])).toEqual([["<cmd>", "user-prepend", { kind: "user", timestamp: 7 }]]);
	});

	it("never enters a tool result (takeOneShots leaves it); `once` text is not queued twice while pending", () => {
		const q = new ReminderQueue();
		q.enqueue("<caveat>", { placement: "user-prepend", raw: true, once: true });
		brief(q);
		q.enqueue("<caveat>", { placement: "user-prepend", raw: true, once: true });
		brief(q); // a second identical command block is a second command — kept
		expect(q.takeOneShots()).toEqual([]);
		q.pin({ kind: "user", timestamp: 1 }, "user-prepend");
		expect(q.drain([user("x", 1)]).map((e) => e.text)).toEqual(["<caveat>", "<cmd>", "<cmd>"]);
		// A later command starts a new run: the caveat is queued again.
		q.enqueue("<caveat>", { placement: "user-prepend", raw: true, once: true });
		expect(q.hasPending("user-prepend")).toBe(true);
	});

	it("openingUserAnchor names a trailing user-like message only", () => {
		expect(openingUserAnchor([user("a", 3)])).toEqual({ kind: "user", timestamp: 3 });
		expect(openingUserAnchor([user("a", 3), assistant(), toolResult()])).toBeUndefined();
		expect(openingUserAnchor([{ role: "custom", content: "tick", timestamp: 9 } as any])).toEqual({ kind: "user", timestamp: 9 });
		expect(openingUserAnchor([])).toBeUndefined();
	});

	it("injects a pinned breadcrumb BEFORE the user text, after the first-prepend stack, raw", () => {
		const messages = [user("build it", 5)];
		const out = injectReminders(messages, [
			{ text: "ctx", placement: "first-prepend", order: 50 },
			{ text: "<caveat>\n", placement: "user-prepend", order: 0, raw: true, pin: { kind: "user", timestamp: 5 } },
			{ text: "<command-name>/clear</command-name>\n", placement: "user-prepend", order: 0, raw: true, pin: { kind: "user", timestamp: 5 } },
			{ text: "budget", placement: "sticky-append", order: 0, raw: true, since: 0 },
		]);
		expect(blockTexts(out[0])).toEqual([wrapReminder("ctx"), "<caveat>\n", "<command-name>/clear</command-name>\n", "build it", "budget"]);
	});

	it("a pinned breadcrumb rides its own message on a later request, not the new prompt", () => {
		const out = injectReminders(
			[user("first", 1), assistant(), user("second", 2)],
			[{ text: "<crumb>\n", placement: "user-prepend", order: 0, raw: true, pin: { kind: "user", timestamp: 1 } }],
		);
		expect(blockTexts(out[0])).toEqual(["<crumb>\n", "first"]);
		expect(blockTexts(out[2])).toEqual(["second"]);
	});
});
