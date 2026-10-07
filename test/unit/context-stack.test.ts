import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CONTEXT_BASELINE_CHANNEL, CONTEXT_STACK_ENTRY, CONTEXT_STATE_ENTRY, contextStackOnBranch, restoredContext, RESTORED_STACK_KEYS, LIVE_CONTEXT_KEYS, type ContextStackSnapshot } from "../../extensions/lib/context-stack.ts";
import { injectReminders, REMINDER_CHANNEL, ReminderQueue, type ReminderEntry } from "../../extensions/lib/reminders.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import contextBudgetExtension from "../../extensions/context-budget/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const block = (key: string, text = key, extra: Partial<ReminderEntry> = {}): ReminderEntry => ({ key, text, placement: "first-prepend", order: 50, ...extra });
const custom = (data: unknown, customType = CONTEXT_STACK_ENTRY) => ({ type: "custom", customType, data });
const snapshot = (stack: ReminderEntry[] = [], sticky: ReminderEntry[] = []): ContextStackSnapshot => ({ version: 1, stack, sticky, baselines: {} });
const branchOf = (fake: ReturnType<typeof createFakePi>) => JSON.parse(JSON.stringify(fake.appendedEntries.map((e) => ({ type: "custom", ...e }))));

async function start(branch: ReturnType<typeof custom>[] = [], reason = "startup", budget = false) {
	const fake = createFakePi();
	if (budget) contextBudgetExtension(fake.pi as never);
	systemReminderExtension(fake.pi as never);
	const ctx = createFakeCtx({ sessionManager: { getBranch: () => branch } });
	await fake.fire("session_start", { reason }, ctx);
	const request = async (messages: AgentMessage[]) => (await fake.fireOne<{ messages: AgentMessage[] }>("context", { messages }, ctx))?.messages ?? messages;
	const emit = (entry: ReminderEntry) => fake.events.emit(REMINDER_CHANNEL, { scope: "every-turn", ...entry });
	return { fake, ctx, request, emit };
}

describe("context snapshot reader", () => {
	it("validates versions and shapes, reads branch-local updates, and returns detached values", () => {
		const original = snapshot([block("claude-context")]);
		const state = { version: 1, sticky: [block("mode", "auto", { placement: "sticky-append", since: 10, opener: null })], baselines: { "permission-mode": "auto" } };
		const result = contextStackOnBranch([custom(original), custom(state, CONTEXT_STATE_ENTRY)])!;
		expect(result.stack).toEqual(original.stack);
		expect(result.sticky).toEqual(state.sticky);
		result.stack[0].text = "mutated";
		expect(original.stack[0].text).toBe("claude-context");
		for (const bad of [null, { ...original, version: 2 }, { ...original, stack: [{}] }, { ...original, sticky: [block("bad")] }]) {
			expect(contextStackOnBranch([custom(bad)])).toBeUndefined();
		}
		expect(contextStackOnBranch([custom(state, CONTEXT_STATE_ENTRY)])).toBeUndefined();
		expect(contextStackOnBranch([custom(original), custom({ ...state, sticky: [{ ...state.sticky[0], since: "yesterday" }] }, CONTEXT_STATE_ENTRY)])).toEqual(original);
	});

	it("rejects malformed closed boundaries and pin snapshots without partially restoring them", () => {
		const original = snapshot([block("claude-context")]);
		const sticky = block("mode", "plan", { placement: "sticky-append", since: 1 });
		for (const until of ["later", null, Infinity, NaN]) {
			expect(contextStackOnBranch([custom(original), custom({ version: 1, sticky: [{ ...sticky, until }], baselines: {} }, CONTEXT_STATE_ENTRY)])).toEqual(original);
		}
		for (const pinned of [[{ ...sticky, pin: { kind: "user", timestamp: 1 } }], [block("bad", "bad", { placement: "last-append" })], "bad"]) {
			expect(contextStackOnBranch([custom({ ...original, pinned })])).toBeUndefined();
		}
	});

	it("follows real pi fork ancestry and keeps custom metadata out of projected messages", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("first", 1) as never);
		manager.appendCustomEntry(CONTEXT_STACK_ENTRY, snapshot([block("claude-context", "original")]));
		const forkPoint = manager.appendMessage(user("second", 2) as never);
		manager.appendCompaction("summary", null, 100);
		manager.appendCustomEntry(CONTEXT_STATE_ENTRY, { version: 1, stack: [block("claude-context", "refreshed")], sticky: [], baselines: {} });
		expect(contextStackOnBranch(manager.getBranch())?.stack[0].text).toBe("refreshed");
		expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("refreshed");
		manager.createBranchedSession(forkPoint);
		expect(contextStackOnBranch(manager.getBranch())?.stack[0].text).toBe("original");
		expect(manager.buildSessionContext().messages).toHaveLength(2);
	});

	it("restores the last explicitly rewritten capability prefix, not an obsolete initial copy", () => {
		const initial = snapshot([block("model-line", "old model")]);
		const stack = [block("model-line", "new model")];
		expect(contextStackOnBranch([custom(initial), custom({ version: 1, stack, sticky: [], baselines: {} }, CONTEXT_STATE_ENTRY)])?.stack).toEqual(stack);
	});
});

describe("restored reminder queue", () => {
	it("freezes session facts and phase-2 keys including absence; other capabilities use live text", () => {
		const queue = new ReminderQueue(() => 100);
		queue.restore([block("claude-context", "old rules"), block("environment", "old environment"), block("deferred-tools", "old tools")], [], RESTORED_STACK_KEYS);
		for (const entry of [block("claude-context", "new rules"), block("one-code-context", "new file"), block("deferred-tools", "new tools"), block("environment", "new environment")]) queue.enqueue(entry.text, { ...entry, scope: "every-turn" });
		queue.remove("claude-context");
		expect(queue.persistentEntries("first-prepend").map((e) => e.text)).toEqual(["old rules", "new environment", "old tools"]);
	});

	it("drops phase-1 capabilities not re-emitted, while retaining identical live and frozen blocks", () => {
		const queue = new ReminderQueue();
		queue.restore([block("skills", "removed skills"), block("environment", "same environment"), block("one-shot", "old print mode"), block("claude-context", "rules")], [], RESTORED_STACK_KEYS, LIVE_CONTEXT_KEYS);
		queue.enqueue("same environment", { scope: "every-turn", key: "environment", placement: "first-prepend", order: 50 });
		queue.finishRestore();
		expect(queue.persistentEntries("first-prepend").map((entry) => entry.text)).toEqual(["same environment", "rules"]);
	});

	it("retains opener and tail pin on same-text re-emits, but a changed state anchors now", () => {
		const queue = new ReminderQueue(() => 100);
		const entry = block("permission-mode", "auto", { placement: "sticky-append", order: 0, since: 20, opener: 10, tailPin: { kind: "toolResult", toolCallId: "c" } });
		queue.restore([], [entry], RESTORED_STACK_KEYS);
		queue.enqueue("auto", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		expect(queue.persistentEntries("sticky-append")[0]).toMatchObject(entry);
		queue.enqueue("plan", { scope: "every-turn", key: "permission-mode", placement: "sticky-append" });
		expect(queue.persistentEntries("sticky-append")[0]).toMatchObject({ ...entry, until: 100 });
		expect(queue.persistentEntries("sticky-append")[1]).toMatchObject({ text: "plan", since: 100 });
		expect(queue.persistentEntries("sticky-append")[1].opener).toBeUndefined();
	});
});

describe("context snapshot owner", () => {
	it("does not change fresh request bytes and writes once only after a carrier exists", async () => {
		const run = await start();
		const entries = [block("claude-context", "original rules", { suffix: "\n\n" }), block("date", "date", { order: 56 }), block("permission-mode", "auto", { placement: "sticky-append", since: 0 })];
		for (const entry of entries) run.emit(entry);
		await run.request([]);
		expect(run.fake.appendedEntries).toHaveLength(0);
		const messages = [user("first", 10), user("second", 20)];
		expect(JSON.stringify(await run.request(messages))).toBe(JSON.stringify(injectReminders(messages, entries)));
		await run.request(messages);
		expect(run.fake.appendedEntries).toHaveLength(1);
		expect(run.fake.appendedEntries[0].customType).toBe(CONTEXT_STACK_ENTRY);
		expect(contextStackOnBranch(branchOf(run.fake))?.sticky[0].opener).toBeNull();
	});

	it.each(["startup", "resume", "fork", "reload"])("keeps every earlier user message byte-identical on %s", async (reason) => {
		const first = await start();
		first.emit(block("claude-context", "rules and old memory", { suffix: "\n\n" }));
		first.emit(block("claude-context-context", "old git snapshot"));
		first.emit(block("permission-mode", "auto", { placement: "sticky-append", since: 0 }));
		const previous = [user("one", 10), user("two", 20)];
		const sent = await first.request(previous);
		const resumed = await start(branchOf(first.fake), reason);
		resumed.emit(block("claude-context", "edited rules and memory"));
		resumed.emit(block("claude-context-context", "new git snapshot"));
		resumed.emit(block("permission-mode", "auto", { placement: "sticky-append" }));
		const next = await resumed.request([...previous, user("three", 30)]);
		expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(sent));
		expect(resumed.fake.appendedEntries).toHaveLength(1);
		expect((resumed.fake.appendedEntries[0].data as ContextStackSnapshot).sticky[0].userPins).toEqual([10, 20, 30]);
	});

	it("keeps early context-budget emissions without losing their restored anchors", async () => {
		const first = await start([], "startup", true);
		const messages = [user("first", 10), user("second", 20)];
		const sent = await first.request(messages);
		const resumed = await start(branchOf(first.fake), "startup", true);
		expect(await resumed.request(messages)).toEqual(sent);
		expect(resumed.fake.appendedEntries).toHaveLength(0);
	});

	it("persists closed sticky lifetimes and their one-shot pins; baseline snapshots cannot mutate", async () => {
		const run = await start();
		run.emit(block("permission-mode", "auto", { placement: "sticky-append", since: 0 }));
		run.fake.events.emit(CONTEXT_BASELINE_CHANNEL, { key: "models", value: ["a"] });
		await run.request([user("first", 10)]);
		run.fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode", remove: true });
		run.fake.events.emit(REMINDER_CHANNEL, { text: "one shot" });
		run.fake.events.emit(CONTEXT_BASELINE_CHANNEL, { key: "models", value: ["b"] });
		await run.request([user("first", 10), user("second", 20)]);
		expect((run.fake.appendedEntries[0].data as ContextStackSnapshot).baselines.models).toEqual(["a"]);
		const restored = contextStackOnBranch(branchOf(run.fake))!;
		expect(restored.sticky).toEqual([expect.objectContaining({ text: "auto", since: 0, until: expect.any(Number) })]);
		expect(restored.baselines.models).toEqual(["b"]);
		const resumed = await start(branchOf(run.fake));
		expect(restored.pinned).toEqual([expect.objectContaining({ text: "one shot", pin: { kind: "user", timestamp: 20 } })]);
		expect(JSON.stringify(await resumed.request([user("first", 10), user("second", 20)]))).toContain("one shot");
	});

	it("stores provider-neutral blocks and keeps the stack on a compaction summary", async () => {
		const first = await start();
		first.emit(block("auto-mode-note", "system only", { order: 45, systemRoleOnly: true }));
		first.emit(block("claude-context", "rules"));
		expect(JSON.stringify(await first.request([user("first", 10)]))).not.toContain("system only");
		const saved = contextStackOnBranch(branchOf(first.fake))!;
		expect(saved.stack.map((e) => e.text)).toEqual(["system only", "rules"]);
		const resumed = await start(branchOf(first.fake));
		const summary = { role: "compactionSummary", summary: "summary text", timestamp: 30 } as AgentMessage;
		expect(await resumed.request([summary])).toEqual(await first.request([summary]));
		expect(JSON.stringify(await resumed.request([summary]))).toContain("rules");
	});

	it("/clear after a resume releases the resume locks in the same extension instance", async () => {
		let branch: ReturnType<typeof custom>[] = [custom(snapshot([block("claude-context", "old rules")]))];
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const ctx = createFakeCtx({ sessionManager: { getBranch: () => branch } });
		await fake.fire("session_start", { reason: "resume" }, ctx);
		branch = [];
		await fake.fire("session_start", { reason: "new" }, ctx);
		fake.events.emit(REMINDER_CHANNEL, { scope: "every-turn", ...block("claude-context", "fresh rules") });
		const sent = JSON.stringify((await fake.fireOne<{ messages: AgentMessage[] }>("context", { messages: [user("new", 100)] }, ctx))?.messages);
		expect(sent).toContain("fresh rules");
		expect(sent).not.toContain("old rules");
	});

	it("restores a /tree branch's pins and closed lifetimes, but never its stale open state", async () => {
		let branch: unknown[] = [];
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		const ctx = createFakeCtx({ sessionManager: { getBranch: () => branch } });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const request = async (messages: AgentMessage[]) => (await fake.fireOne<{ messages: AgentMessage[] }>("context", { messages }, ctx))?.messages ?? messages;
		const emit = (entry: ReminderEntry) => fake.events.emit(REMINDER_CHANNEL, { scope: "every-turn", ...entry });
		emit(block("permission-mode", "auto", { placement: "sticky-append", since: 0 }));
		emit(block("plan", "plan on", { placement: "sticky-append", since: 0 }));
		await request([user("one", 10)]);
		fake.events.emit(REMINDER_CHANNEL, { key: "plan", remove: true });
		fake.events.emit(REMINDER_CHANNEL, { text: "one shot" });
		const a = [user("one", 10), user("two", 20)];
		const sentA = await request(a);
		expect(JSON.stringify(sentA[1])).toContain("one shot");
		const branchA = branchOf(fake);

		// Branch B forks after message one: the pin and plan's carrier "two" are not on it.
		branch = branchA.slice(0, 1);
		await fake.fire("session_tree", {}, ctx);
		fake.events.emit(REMINDER_CHANNEL, { key: "permission-mode", remove: true });
		const sentB = await request([user("one", 10), user("three", 30)]);
		expect(JSON.stringify(sentB[1])).not.toContain("one shot");
		expect(JSON.stringify(sentB[1])).not.toContain("auto");

		branch = branchA;
		await fake.fire("session_tree", {}, ctx);
		const back = await request([...a, user("four", 40)]);
		expect(JSON.stringify(back.slice(0, 2))).toBe(JSON.stringify(sentA));
		// Auto mode was switched off live; the branch's history keeps its blocks, the new prompt does not claim it.
		expect(JSON.stringify(back[2])).not.toContain("auto");
	});

	it("a fresh /clear or old session without metadata does not inherit another stack", async () => {
		const first = await start([custom(snapshot([block("claude-context", "old")]))]);
		expect(restoredContext(first.fake.events)?.stack[0].text).toBe("old");
		const fresh = await start([], "new");
		expect(restoredContext(fresh.fake.events)).toBeUndefined();
		fresh.emit(block("claude-context", "fresh"));
		expect(JSON.stringify(await fresh.request([user("new", 100)]))).toContain("fresh");
	});
});
