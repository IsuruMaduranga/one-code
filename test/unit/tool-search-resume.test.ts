import { beforeEach, describe, expect, it } from "vitest";
import { DEFER_CHANNEL } from "../../extensions/lib/deferred.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { createFakeCtx } from "./helpers/fake-pi.ts";
import { makeToolSearchFakePi } from "./helpers/tool-search-fake-pi.ts";

/**
 * A resumed session keeps the deferred tools its transcript already loaded.
 * pi 0.86 restores the transcript's active tools before session_start; the
 * transcript tells the model those tools are callable (and Claude Code keeps a
 * ToolSearch-loaded tool callable across a resume), so tool-search must not
 * defer them again — that sent the model into a "Tool <name> not found" round
 * trip on every resume. A fresh branch (startup, /clear) defers everything.
 */

const loadEntry = (toolCallId: string, added: string[]) => ({
	type: "message",
	message: { role: "toolResult", toolName: "tool_search", toolCallId, details: { added, matches: added, notFound: [] } },
});
const ctxWithBranch = (entries: unknown[]) => createFakeCtx({ sessionManager: { getBranch: () => entries } });

describe("tool-search on a resumed session", () => {
	let fake: ReturnType<typeof makeToolSearchFakePi>;

	beforeEach(() => {
		fake = makeToolSearchFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		toolSearchExtension(fake.pi as any);
		fake.addDeferred("web_fetch");
		fake.addDeferred("notebook_edit");
		// pi restored every tool the transcript had active, loaded ones included.
		fake.setActive(["read", "web_fetch", "notebook_edit"]);
	});

	it("keeps a tool the transcript loaded active and defers the rest", () => {
		fake.pi.fire("session_start", { type: "session_start", reason: "resume" }, ctxWithBranch([loadEntry("toolu_1", ["web_fetch"])]));
		expect(fake.activeTools()).toEqual(["read", "web_fetch"]);
	});

	it("defers everything on a fresh branch, and without a session manager", () => {
		fake.pi.fire("session_start", { type: "session_start", reason: "startup" }, ctxWithBranch([]));
		expect(fake.activeTools()).toEqual(["read"]);
		fake.setActive(["read", "web_fetch", "notebook_edit"]);
		fake.pi.fire("session_start", { type: "session_start", reason: "new" });
		expect(fake.activeTools()).toEqual(["read"]);
	});

	it("leaves a late-registering loaded tool (an MCP server's) active, and still defers an unloaded one", () => {
		fake.pi.fire("session_start", { type: "session_start", reason: "resume" }, ctxWithBranch([loadEntry("toolu_1", ["mcp__s__loaded"])]));
		// MCP tools register (active) after session_start and defer themselves then.
		fake.allTools.push({ name: "mcp__s__loaded", description: "loaded" }, { name: "mcp__s__other", description: "other" });
		fake.setActive([...fake.activeTools(), "mcp__s__loaded", "mcp__s__other"]);
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__s__loaded" });
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__s__other" });
		expect(fake.activeTools()).toEqual(["read", "mcp__s__loaded"]);
	});

	it("reads an unchanged branch once however often it reconciles (a turn, a defer burst), and again once it changes", () => {
		let reads = 0;
		const counted = (entry: { type: string; message: unknown }) => {
			const { message } = entry;
			return Object.defineProperty({ type: entry.type }, "message", { enumerable: true, get: () => (reads++, message) });
		};
		const entries = [counted(loadEntry("toolu_1", ["web_fetch"]))];
		const ctx = ctxWithBranch(entries);
		fake.pi.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
		expect(fake.activeTools()).toEqual(["read", "web_fetch"]);
		const once = reads;
		expect(once).toBeGreaterThan(0);
		fake.pi.fire("turn_start", { type: "turn_start" }, ctx);
		fake.allTools.push({ name: "mcp__s__a", description: "a" }, { name: "mcp__s__b", description: "b" });
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__s__a" });
		fake.pi.events.emit(DEFER_CHANNEL, { name: "mcp__s__b" });
		fake.pi.fire("turn_start", { type: "turn_start" }, ctx);
		expect(reads).toBe(once);
		expect(fake.activeTools()).toEqual(["read", "web_fetch"]);
		// A load lands on the branch: the next reconcile reads it.
		entries.push(counted(loadEntry("toolu_2", ["notebook_edit"])));
		fake.pi.fire("turn_start", { type: "turn_start" }, ctx);
		expect(reads).toBeGreaterThan(once);
		expect(fake.activeTools()).toEqual(["read", "web_fetch", "notebook_edit"]);
	});

	it("forgets the previous session's loads on /clear (the new branch is empty)", () => {
		fake.pi.fire("session_start", { type: "session_start", reason: "resume" }, ctxWithBranch([loadEntry("toolu_1", ["web_fetch"])]));
		expect(fake.activeTools()).toContain("web_fetch");
		fake.setActive(["read", "web_fetch", "notebook_edit"]);
		fake.pi.fire("session_start", { type: "session_start", reason: "new" }, ctxWithBranch([]));
		expect(fake.activeTools()).toEqual(["read"]);
	});

	it("leaves a deferred tool inactive after a direct call to it failed as not found, and activates one whose call ran", () => {
		const callEntry = (id: string, name: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] } });
		const resultEntry = (id: string, name: string, text: string, isError: boolean) => ({
			type: "message",
			message: { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] },
		});
		const entries = [callEntry("c1", "web_fetch"), resultEntry("c1", "web_fetch", "Tool web_fetch not found", true)];
		const ctx = ctxWithBranch(entries);
		fake.pi.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
		fake.pi.fire("turn_start", { type: "turn_start" }, ctx);
		expect(fake.activeTools()).toEqual(["read"]);
		// A call that ran (its load summarized away) keeps its tool in use.
		entries.push(callEntry("c2", "notebook_edit"), resultEntry("c2", "notebook_edit", "Edited cell 1", false));
		fake.pi.fire("turn_start", { type: "turn_start" }, ctx);
		expect(fake.activeTools()).toEqual(["read", "notebook_edit"]);
	});
});
