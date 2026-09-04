import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFER_CHANNEL, deferredAddendumText } from "../../extensions/lib/deferred.ts";
import { MCP_TOOLS_CHANNEL } from "../../extensions/lib/mcp-share.ts";
import { applyAnnouncement, planAnnouncement } from "../../extensions/tool-search/announce.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { makeToolSearchFakePi, type Reminder } from "./helpers/tool-search-fake-pi.ts";

/**
 * The deferred-tools listing on message 1 must be FROZEN once a request has
 * gone out (rewriting it re-caches the whole conversation — measured 16.7k
 * tokens on request 2, 2026-09-04). Late arrivals ride a one-shot addendum.
 * Pure planner tests first, then the real extension against a fake pi with
 * fake timers for the announce debounce.
 */

describe("planAnnouncement", () => {
	it("rewrites the listing with every name while nothing is cached", () => {
		expect(planAnnouncement({ requestSent: false, announced: new Set(), available: ["a", "b"] })).toEqual({
			kind: "rewrite",
			names: ["a", "b"],
		});
		expect(planAnnouncement({ requestSent: false, announced: new Set(["a"]), available: [] })).toEqual({ kind: "none" });
	});

	it("announces only the new names once a request has gone out", () => {
		expect(planAnnouncement({ requestSent: true, announced: new Set(["a"]), available: ["a", "b", "c"] })).toEqual({
			kind: "addendum",
			added: ["b", "c"],
		});
		expect(planAnnouncement({ requestSent: true, announced: new Set(["a", "b"]), available: ["a", "b"] })).toEqual({
			kind: "none",
		});
	});

	it("does not announce names that disappeared (the frozen listing keeps them)", () => {
		expect(planAnnouncement({ requestSent: true, announced: new Set(["a", "b"]), available: ["a"] })).toEqual({
			kind: "none",
		});
	});

	it("applyAnnouncement tracks what the model was told", () => {
		const announced = new Set(["stale"]);
		applyAnnouncement(announced, { kind: "rewrite", names: ["a"] });
		expect([...announced]).toEqual(["a"]);
		applyAnnouncement(announced, { kind: "addendum", added: ["b"] });
		expect([...announced]).toEqual(["a", "b"]);
		applyAnnouncement(announced, { kind: "none" });
		expect([...announced]).toEqual(["a", "b"]);
	});
});

const makeFakePi = () => makeToolSearchFakePi(["read", "bash"]);

const listings = (reminders: Reminder[]) => reminders.filter((r) => r.key === "deferred-tools");
const addenda = (reminders: Reminder[]) =>
	reminders.filter((r) => r.key === undefined && r.text?.startsWith("Additional deferred tools became available"));

describe("tool-search announce wiring", () => {
	let fake: ReturnType<typeof makeFakePi>;

	beforeEach(() => {
		vi.useFakeTimers();
		fake = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		toolSearchExtension(fake.pi as any);
		fake.addDeferred("web_fetch");
		fake.pi.fire("session_start", {});
	});
	afterEach(() => vi.useRealTimers());

	it("writes the standing listing at session start and rewrites it for defers before the first request", async () => {
		expect(listings(fake.reminders)).toHaveLength(1);
		expect(listings(fake.reminders)[0].placement).toBe("first-prepend");
		expect(listings(fake.reminders)[0].text).toContain("web_fetch");

		fake.addDeferred("lsp_diagnostics");
		await vi.advanceTimersByTimeAsync(150);
		const all = listings(fake.reminders);
		expect(all).toHaveLength(2);
		expect(all[1].text).toContain("lsp_diagnostics");
		expect(addenda(fake.reminders)).toHaveLength(0);
		expect(fake.activeTools()).not.toContain("lsp_diagnostics");
	});

	it("after the first request a late defer becomes a one-shot addendum and the listing stays frozen", async () => {
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		fake.pi.fire("context", { messages: [] });
		fake.reminders.length = 0;

		fake.addDeferred("mcp__deepwiki__ask_question");
		await vi.advanceTimersByTimeAsync(150);

		expect(listings(fake.reminders)).toHaveLength(0);
		const notes = addenda(fake.reminders);
		expect(notes).toHaveLength(1);
		expect(notes[0].text).toBe(deferredAddendumText(["mcp__deepwiki__ask_question"]));
		expect(notes[0].text).not.toContain("web_fetch");
		expect(notes[0].scope).toBeUndefined();
	});

	it("a request going out during the debounce turns the pending rewrite into an addendum (the -p race)", async () => {
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		fake.reminders.length = 0;
		fake.addDeferred("mcp__late__tool"); // timer scheduled, request not yet sent
		fake.pi.fire("context", { messages: [] }); // first request goes out inside the window
		await vi.advanceTimersByTimeAsync(150);

		expect(listings(fake.reminders)).toHaveLength(0);
		expect(addenda(fake.reminders)).toHaveLength(1);
		expect(addenda(fake.reminders)[0].text).toContain("mcp__late__tool");
	});

	it("holds post-request defers until the MCP connect settles, then sends one addendum", async () => {
		fake.pi.fire("context", { messages: [] });
		fake.reminders.length = 0;
		fake.addDeferred("mcp__a__x");
		fake.addDeferred("mcp__a__y");
		await vi.advanceTimersByTimeAsync(500);
		expect(addenda(fake.reminders)).toHaveLength(0);

		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		const notes = addenda(fake.reminders);
		expect(notes).toHaveLength(1);
		expect(notes[0].text).toContain("mcp__a__x");
		expect(notes[0].text).toContain("mcp__a__y");
		expect(listings(fake.reminders)).toHaveLength(0);
	});

	it("does not announce the same name twice", async () => {
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		fake.pi.fire("context", { messages: [] });
		fake.reminders.length = 0;
		fake.addDeferred("mcp__b__z");
		await vi.advanceTimersByTimeAsync(150);
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__b__z", keywords: ["again"] });
		await vi.advanceTimersByTimeAsync(150);
		expect(addenda(fake.reminders)).toHaveLength(1);
	});

	it("a new session starts over with a fresh listing", async () => {
		fake.pi.events.emit(MCP_TOOLS_CHANNEL, { tools: [], settled: true });
		fake.pi.fire("context", { messages: [] });
		fake.addDeferred("mcp__c__w");
		await vi.advanceTimersByTimeAsync(150);
		fake.reminders.length = 0;

		fake.pi.fire("session_start", {});
		const all = listings(fake.reminders);
		expect(all).toHaveLength(1);
		expect(all[0].text).toContain("web_fetch");
		expect(all[0].text).toContain("mcp__c__w");
	});
});
