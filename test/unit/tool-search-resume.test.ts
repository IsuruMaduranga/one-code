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

	it("forgets the previous session's loads on /clear (the new branch is empty)", () => {
		fake.pi.fire("session_start", { type: "session_start", reason: "resume" }, ctxWithBranch([loadEntry("toolu_1", ["web_fetch"])]));
		expect(fake.activeTools()).toContain("web_fetch");
		fake.setActive(["read", "web_fetch", "notebook_edit"]);
		fake.pi.fire("session_start", { type: "session_start", reason: "new" }, ctxWithBranch([]));
		expect(fake.activeTools()).toEqual(["read"]);
	});
});
