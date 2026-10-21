/**
 * A subagent defers what its parent defers: the parent's MCP, cron and
 * SendMessage tools are injected into the child, but their owners run only in
 * the parent, so without this the child declared them in full and unlisted
 * (phase 7 of the lifecycle-grid-hunt feature, the weak-model tier runs).
 */
import { describe, expect, it } from "vitest";
import { DEFER_CHANNEL, DEFERRED_QUERY_CHANNEL, type DeferredQuery, deferLikeParentExtension, type DeferRequest } from "../../extensions/lib/deferred.ts";
import toolSearchExtension from "../../extensions/tool-search/index.ts";
import { makeToolSearchFakePi } from "./helpers/tool-search-fake-pi.ts";

describe("deferring like the parent", () => {
	it("has the parent's tool-search answer with every tool it defers, keywords included", () => {
		const parent = makeToolSearchFakePi(["read"]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		toolSearchExtension(parent.pi as any);
		parent.pi.events.emit(DEFER_CHANNEL, { name: "mcp__fixture__lookup", keywords: ["ticket"] });
		parent.pi.events.emit(DEFER_CHANNEL, { name: "cron_create" });
		const query: DeferredQuery = { tools: [] };
		parent.pi.events.emit(DEFERRED_QUERY_CHANNEL, query);
		expect(query.tools).toEqual(expect.arrayContaining([{ name: "mcp__fixture__lookup", keywords: ["ticket"] }, { name: "cron_create", keywords: [] }]));
	});

	it("defers in the child, at load, only the tools injected into it, and its tool-search lists the ones it has", () => {
		const child = makeToolSearchFakePi(["read", "mcp__fixture__lookup"]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		toolSearchExtension(child.pi as any);
		// Injected the way a parent's MCP tool reaches a child: registered, with no owner here to defer it.
		child.allTools.push({ name: "mcp__fixture__lookup", description: "Look up a ticket" });
		const seen: DeferRequest[] = [];
		child.pi.events.on(DEFER_CHANNEL, (data) => seen.push(data as DeferRequest));
		// The parent also defers url_context (a Gemini-only tool the child's own web extension gates by model): not injected, not mirrored.
		deferLikeParentExtension([{ name: "mcp__fixture__lookup", keywords: ["ticket"] }, { name: "cron_create" }, { name: "url_context" }], ["mcp__fixture__lookup", "cron_create", "SendMessage"])(child.pi);
		expect(seen.map((request) => request.name)).toEqual(["mcp__fixture__lookup", "cron_create"]);
		child.pi.fire("session_start", {});
		expect(child.activeTools()).toEqual(["read"]);
		const listing = child.reminders.filter((r) => r.key === "deferred-tools").at(-1)?.text ?? "";
		expect(listing).toContain("mcp__fixture__lookup");
		expect(listing).not.toContain("cron_create");
	});
});
