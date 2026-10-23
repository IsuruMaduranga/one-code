import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	LiveReminders,
	type OneShot,
	type RenderInput,
	renderReminders,
	type StackEntry,
	type StickyToPlace,
	stickyFact,
	toldBlockFact,
	wrapReminder,
} from "../../extensions/lib/reminders.ts";

// Minimal structural stand-ins for AgentMessage
const user = (content: string | Array<{ type: string; text?: string }>, timestamp = 0) => ({ role: "user", content, timestamp }) as any;
const assistant = (timestamp = 0) => ({ role: "assistant", content: [], timestamp }) as any;
const toolResult = (text = "ok", timestamp = 0, toolCallId = "c1") =>
	({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], timestamp }) as any;
const custom = (text: string, timestamp = 0) => ({ role: "custom", customType: "task-notification", content: text, display: true, timestamp }) as any;
const compaction = (summary = "what happened", timestamp = 0) => ({ role: "compactionSummary", summary, tokensBefore: 1, timestamp }) as any;
const blockTexts = (m: any) => (typeof m.content === "string" ? [m.content] : m.content.map((b: any) => b.text));

const stack = (text: string, order = 0, extra: Partial<StackEntry> = {}): StackEntry => ({ key: text, text, order, ...extra });
const sticky = (text: string, since = 0, extra: Partial<StickyToPlace> = {}): StickyToPlace => ({ key: text, text, since, delivered: false, ...extra });
const shot = (text: string, extra: Partial<OneShot> = {}): OneShot => ({ text, placement: "last-append", ...extra });
const render = (messages: any[], input: Partial<RenderInput>) =>
	renderReminders(messages, { epoch: false, layout: false, stack: [], sticky: [], oneShots: [], ...input });

describe("LiveReminders", () => {
	it("keeps the first-prepend stack as live state, in Claude Code's order, replaced by key", () => {
		const live = new LiveReminders();
		expect(live.apply({ text: "claudeMd", placement: "first-prepend", order: 50, key: "md" })).toBe("live");
		live.apply({ text: "env", placement: "first-prepend", order: 1, key: "env" });
		live.apply({ text: "env 2", placement: "first-prepend", order: 1, key: "env" });
		expect(live.stackEntries().map((entry) => entry.text)).toEqual(["env 2", "claudeMd"]);
		live.apply({ key: "md", remove: true });
		expect(live.stackEntries().map((entry) => entry.text)).toEqual(["env 2"]);
	});

	it("hands one-shots back for persisting and ignores empty text", () => {
		const live = new LiveReminders();
		expect(live.apply({ text: "steer" })).toBe("one-shot");
		expect(live.apply({ text: "crumb", placement: "user-prepend" })).toBe("one-shot");
		expect(live.apply({ text: "  " })).toBe("ignored");
		expect(live.stackEntries()).toEqual([]);
		expect(live.stickyEntries()).toEqual([]);
	});

	it("keeps a sticky state's start, and so its told delivery, while its text is unchanged, and starts a new one when it changes", () => {
		let now = 10;
		const live = new LiveReminders(() => now);
		live.apply({ text: "plan", key: "mode", placement: "sticky-append" });
		const delivered = stickyFact(live.stickyEntries()[0]);
		now = 20;
		live.apply({ text: "plan", key: "mode", placement: "sticky-append" });
		expect(live.stickyEntries()).toEqual([{ key: "mode", text: "plan", since: 10 }]);
		expect(stickyFact(live.stickyEntries()[0])).toEqual(delivered);
		live.apply({ text: "auto", key: "mode", placement: "sticky-append" });
		expect(live.stickyEntries()).toEqual([{ key: "mode", text: "auto", since: 20 }]);
		expect(stickyFact(live.stickyEntries()[0]).hash).not.toBe(delivered.hash);
		live.apply({ key: "mode", remove: true });
		expect(live.stickyEntries()).toEqual([]);
	});
});

describe("renderReminders: the stack", () => {
	it("prepends the stack, sorted, before the first user message's text only when the request opens an epoch", () => {
		const messages = [user("one", 1), assistant(2), user("two", 3)];
		const entries = [stack("a", 1), stack("b", 2)];
		const opened = render(messages, { epoch: true, stack: entries });
		expect(blockTexts(opened.messages[0])).toEqual([wrapReminder("a"), wrapReminder("b"), "one"]);
		expect(opened.stackPlaced).toBe(true);
		const inside = render(messages, { stack: entries });
		expect(inside.messages).toEqual(messages);
		expect(inside.stackPlaced).toBe(false);
	});

	it("anchors the stack to a compaction summary, in pi's frame", () => {
		const result = render([compaction("summary text", 5), assistant(), toolResult("ran")], { epoch: true, stack: [stack("claudeMd", 50)], oneShots: [shot("steer")] });
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[0].timestamp).toBe(5);
		expect(blockTexts(result.messages[0])).toEqual([wrapReminder("claudeMd"), `${COMPACTION_SUMMARY_PREFIX}summary text${COMPACTION_SUMMARY_SUFFIX}`]);
		expect(blockTexts(result.messages[2])).toEqual(["ran", wrapReminder("steer")]);
	});

	it("reproduces pi's compaction-summary frame byte for byte", async () => {
		const pi = await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js")).href);
		expect(COMPACTION_SUMMARY_PREFIX).toBe(pi.COMPACTION_SUMMARY_PREFIX);
		expect(COMPACTION_SUMMARY_SUFFIX).toBe(pi.COMPACTION_SUMMARY_SUFFIX);
	});

	it("leaves a system-message-only block out where there is no such message, and moves the session facts where there is", () => {
		const entries = [stack("env", 1), stack("note", 45, { systemRoleOnly: true }), stack("claudeMd", 50), stack("date", 56)];
		const plain = render([user("hi")], { epoch: true, stack: entries });
		expect(blockTexts(plain.messages[0])).toEqual([wrapReminder("env"), wrapReminder("claudeMd"), wrapReminder("date"), "hi"]);
		expect(plain.moved).toEqual([]);
		const layout = render([user("hi")], { epoch: true, layout: true, stack: entries });
		expect(layout.moved.map((block) => block.inner)).toEqual(["env", "note", "date"]);
	});

	it("prepends the stack to a request whose only user-like message is a harness notification", () => {
		const result = render([custom("task done", 4)], { epoch: true, stack: [stack("ctx")] });
		expect(blockTexts(result.messages[0])).toEqual([wrapReminder("ctx"), "task done"]);
	});

	it("does not mutate the input messages", () => {
		const messages = [user("hi")];
		const copy = structuredClone(messages);
		render(messages, { epoch: true, stack: [stack("ctx")], oneShots: [shot("x")] });
		expect(messages).toEqual(copy);
	});
});

describe("renderReminders: sticky states", () => {
	it("rides every user message of the request stamped at or after it switched on, and none before", () => {
		const messages = [user("old", 1), assistant(2), user("new", 5), assistant(6), custom("note", 7)];
		const result = render(messages, { sticky: [sticky("auto", 5)] });
		expect(blockTexts(result.messages[0])).toEqual(["old"]);
		expect(blockTexts(result.messages[2])).toEqual(["new", wrapReminder("auto")]);
		expect(blockTexts(result.messages[4])).toEqual(["note", wrapReminder("auto")]);
		expect(result.stickyPlaced).toEqual(["auto"]);
	});

	it("switched on mid-turn, it first rides the switching call's result", () => {
		const messages = [assistant(1), toolResult("a", 2, "c1"), toolResult("b", 3, "c2")];
		const result = render(messages, { sticky: [sticky("plan", 2, { toolCallId: "c2" })] });
		expect(blockTexts(result.messages[1])).toEqual(["a"]);
		expect(blockTexts(result.messages[2])).toEqual(["b", wrapReminder("plan")]);
	});

	it("without a call, it rides the first result after the switch, never an earlier user turn", () => {
		const messages = [user("opener", 1), assistant(2), toolResult("first", 5), assistant(6), toolResult("second", 7)];
		const result = render(messages, { sticky: [sticky("plan", 4)] });
		expect(blockTexts(result.messages[0])).toEqual(["opener"]);
		expect(blockTexts(result.messages[2])).toEqual(["first", wrapReminder("plan")]);
		expect(blockTexts(result.messages[4])).toEqual(["second"]);
	});

	it("once delivered, it rides only new user messages, not a later tool result", () => {
		const result = render([assistant(1), toolResult("later", 9)], { sticky: [sticky("plan", 4, { delivered: true })] });
		expect(result.stickyPlaced).toEqual([]);
		expect(blockTexts(result.messages[1])).toEqual(["later"]);
	});

	it("with no user turn at all (an overflow compaction kept only a reply and its result), it rides the tail", () => {
		const result = render([assistant(1), toolResult("ran", 2)], { sticky: [sticky("auto", 9)] });
		expect(blockTexts(result.messages[1])).toEqual(["ran", wrapReminder("auto")]);
	});

	it("still pins a state whose switching result was compacted away, to the first later tool result", () => {
		const result = render([assistant(10), toolResult("later", 12)], { sticky: [sticky("plan", 5, { toolCallId: "gone" })] });
		expect(result.stickyPlaced).toEqual(["plan"]);
		expect(JSON.stringify(result.messages[1])).toContain("plan");
	});

	it("never pins a state on from the start (since 0) to a tool result: the constant budget line rides user messages only", () => {
		const budget = sticky("<total_tokens>200000 tokens left</total_tokens>", 0, { raw: true, skipStackCarrier: true });
		const result = render([assistant(1), toolResult("ran", 2)], { sticky: [budget] });
		expect(result.stickyPlaced).toEqual([]);
		expect(JSON.stringify(result.messages)).not.toContain("200000 tokens left");
	});

	it("skipStackCarrier keeps it off the message that carries the stack, on an epoch only", () => {
		const marker = sticky("<total_tokens>1 tokens left</total_tokens>", 0, { raw: true, skipStackCarrier: true });
		const messages = [user("one", 1), assistant(2), user("two", 3)];
		const opened = render(messages, { epoch: true, stack: [stack("ctx")], sticky: [marker] });
		expect(blockTexts(opened.messages[0])).toEqual([wrapReminder("ctx"), "one"]);
		expect(blockTexts(opened.messages[2])).toEqual(["two", marker.text]);
		const inside = render([user("three", 4)], { sticky: [{ ...marker, delivered: true }] });
		expect(blockTexts(inside.messages[0])).toEqual(["three", marker.text]);
	});
});

describe("renderReminders: one-shots", () => {
	it("puts a one-shot on the trailing tool result mid-turn, else on the last user turn", () => {
		const midTurn = render([user("go", 1), assistant(2), toolResult("ran", 3)], { oneShots: [shot("steer", { id: "p1" })] });
		expect(blockTexts(midTurn.messages[0])).toEqual(["go"]);
		expect(blockTexts(midTurn.messages[2])).toEqual(["ran", wrapReminder("steer")]);
		expect(midTurn.placed.map((s) => s.id)).toEqual(["p1"]);
		const prompt = render([assistant(1), toolResult("ran", 2), assistant(3), user("next", 4)], { oneShots: [shot("steer")] });
		expect(blockTexts(prompt.messages[3])).toEqual(["next", wrapReminder("steer")]);
	});

	it("rides its own call's result when the request carries it, never another call's in the batch", () => {
		const messages = [assistant(1), toolResult("a", 2, "c1"), toolResult("b", 3, "c2")];
		const result = render(messages, { oneShots: [shot("countdown", { toolCallId: "c1", raw: true })] });
		expect(blockTexts(result.messages[1])).toEqual(["a", "countdown"]);
		expect(blockTexts(result.messages[2])).toEqual(["b"]);
	});

	it("puts a breadcrumb before the opening prompt's text, after the stack, raw, and once per `once` text", () => {
		const crumbs = [shot("caveat", { placement: "user-prepend", raw: true, once: true, id: "a" }), shot("cmd", { placement: "user-prepend", raw: true, id: "b" }), shot("caveat", { placement: "user-prepend", raw: true, once: true, id: "c" })];
		const result = render([user("hi", 1)], { epoch: true, stack: [stack("ctx")], oneShots: crumbs });
		expect(blockTexts(result.messages[0])).toEqual([wrapReminder("ctx"), "caveat", "cmd", "hi"]);
		expect(result.placed.map((s) => s.id)).toEqual(["a", "b", "c"]);
	});

	it("keeps a breadcrumb waiting mid-turn: it never rides a tool result", () => {
		const result = render([user("go", 1), assistant(2), toolResult("ran", 3)], { oneShots: [shot("cmd", { placement: "user-prepend" })] });
		expect(result.placed).toEqual([]);
		expect(blockTexts(result.messages[2])).toEqual(["ran"]);
	});

	it("puts an `orTail` breadcrumb (a post-compaction restore) on the tail mid-turn, and before the prompt's text when one opens the request (R3-M16)", () => {
		const restore = shot("restored a.ts", { placement: "user-prepend", orTail: true, id: "r" });
		const midTurn = render([user("go", 1), assistant(2), toolResult("ran", 3)], { oneShots: [restore] });
		expect(midTurn.placed.map((s) => s.id)).toEqual(["r"]);
		expect(blockTexts(midTurn.messages[2])).toEqual(["ran", wrapReminder("restored a.ts")]);
		const opening = render([user("next", 1)], { oneShots: [restore] });
		expect(blockTexts(opening.messages[0])).toEqual([wrapReminder("restored a.ts"), "next"]);
	});

	it("places nothing, and leaves every one-shot pending, when nothing can carry it", () => {
		const result = render([assistant(1)], { oneShots: [shot("steer")] });
		expect(result.placed).toEqual([]);
		expect(result.messages).toEqual([assistant(1)]);
	});

	it("puts a one-shot on a harness notification that opened the turn", () => {
		const result = render([user("earlier", 1), assistant(2), custom("agent done", 3)], { oneShots: [shot("steer")] });
		expect(blockTexts(result.messages[2])).toEqual(["agent done", wrapReminder("steer")]);
	});
});

describe("whole-text block facts", () => {
	it("hash the told text, so the same text is the same fact and another is not", () => {
		expect(toldBlockFact("menu", "A")).toEqual(toldBlockFact("menu", "A"));
		expect(toldBlockFact("menu", "A").hash).not.toBe(toldBlockFact("menu", "B").hash);
	});
});
