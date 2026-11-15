import { describe, expect, it } from "vitest";
import { deferredAddendumText, stabilizeDeferredTools } from "../../extensions/lib/request/deferred.ts";
import { wrapReminder } from "../../extensions/lib/request/reminders.ts";
import { addendumNames, carriedAddenda, liftAddenda, supportsToolAdditions, withToolAdditions } from "../../extensions/request/tool-search/tool-additions.ts";
import { toolSearchResultText } from "../../extensions/lib/request/tool-search-text.ts";

const TOOLS_AVAILABLE = toolSearchResultText.toolsAvailable;

const framed = wrapReminder(deferredAddendumText(["mcp__s__a", "mcp__s__b"]));
/** The request carries the addendum block with the facts it was built with (the ledger plan's `carried`). */
const addenda = carriedAddenda([{ text: deferredAddendumText(["mcp__s__a", "mcp__s__b"]), facts: [{ kind: "tools", names: ["mcp__s__a", "mcp__s__b"], callable: true }] }]);

describe("supportsToolAdditions", () => {
	it("needs first-party Anthropic and both of pi's mid-conversation flags", () => {
		const flags = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
		expect(supportsToolAdditions({ id: "claude-opus-5-5", provider: "anthropic", api: "anthropic-messages", compat: flags })).toBe(true);
		expect(supportsToolAdditions({ id: "claude-opus-5-5", provider: "opencode", api: "anthropic-messages", compat: flags })).toBe(false);
		expect(supportsToolAdditions({ id: "claude-opus-5-5", provider: "anthropic", api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true } })).toBe(false);
		expect(supportsToolAdditions({ id: "claude-haiku-4-5", provider: "anthropic", api: "anthropic-messages", compat: flags })).toBe(false);
		expect(supportsToolAdditions(undefined)).toBe(false);
	});
});

describe("liftAddenda and withToolAdditions", () => {
	it("lifts an addendum block off a tool result by call id and sends Claude Code's addition message after it", () => {
		const stored = [
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "done" }, { type: "text", text: framed }, { type: "text", text: "<system-reminder>\nnote\n</system-reminder>" }] },
		];
		const { messages, byCall } = liftAddenda(stored, addenda);
		expect(messages[1].content).toEqual([{ type: "text", text: "done" }, { type: "text", text: "<system-reminder>\nnote\n</system-reminder>" }]);
		expect(byCall).toEqual(new Map([["t", ["mcp__s__a", "mcp__s__b"]]]));
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t" }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done\n<system-reminder>\nnote\n</system-reminder>" }] },
			],
		};
		const out = withToolAdditions(payload, byCall)!;
		expect(out.names).toEqual(["mcp__s__a", "mcp__s__b"]);
		expect((out.payload.messages as unknown[])[3]).toEqual({
			role: "system",
			content: [
				{ type: "text", text: `${TOOLS_AVAILABLE}\nmcp__s__a\nmcp__s__b` },
				{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__s__a" } },
				{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__s__b" } },
			],
		});
	});

	it("never reads an addendum quoted inside other text", () => {
		const quoted = [{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: `cat notes.txt\n${framed}` }] }];
		expect(liftAddenda(quoted, addenda).byCall.size).toBe(0);
		expect(addendumNames(`x\n${framed}`, addenda)).toBeUndefined();
	});

	it("lifts a pinned addendum part off a user message, and leaves a request without one alone", () => {
		const out = withToolAdditions({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: framed }] }] }, new Map(), addenda)!;
		expect((out.payload.messages as Array<{ content: unknown[] }>)[0].content).toEqual([{ type: "text", text: "hi" }]);
		expect(withToolAdditions({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, new Map(), addenda)).toBeUndefined();
	});

	it("reads the names of a whole framed addendum block the request carries, and of no other", () => {
		expect(addendumNames(framed, addenda)).toEqual(["mcp__s__a", "mcp__s__b"]);
		expect(addendumNames(`note\n${framed}`, addenda)).toBeUndefined();
		// The same text the request does not carry (typed by the user, quoted by a tool) is no addendum.
		expect(addendumNames(framed, new Map())).toBeUndefined();
	});

	describe("a late tool with a listing hint", () => {
		const hints = { listingHints: { list_mcp_resources: "When you are about to say what resources the MCP servers offer: use it" } };
		const registry = [
			{ name: "read", parameters: { properties: {} } },
			{ name: "list_mcp_resources", description: "L", parameters: { properties: {} } },
			{ name: "mcp__s__plain", description: "P", parameters: { properties: {} } },
		];
		const isDeferred = (name: string) => name !== "read";
		// pi renders the batch's tools eager, after the ones it had.
		const payload = (names: string[]) => ({
			tools: [{ name: "read", input_schema: {} }, ...names.map((name) => ({ name, input_schema: {} }))],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
			],
		});

		it.each([
			["with a hint", ["list_mcp_resources"]],
			["without a hint", ["mcp__s__plain"]],
			["both in one batch", ["list_mcp_resources", "mcp__s__plain"]],
		])("is referenced by its real name and declared deferred, %s", (_case, names) => {
			const text = deferredAddendumText(names, hints);
			if (names.includes("list_mcp_resources")) expect(text).toContain("list_mcp_resources: When you are about to");
			const carried = carriedAddenda([{ text, facts: [{ kind: "tools", names, callable: true }] }]);
			const stored = [{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "done" }, { type: "text", text: wrapReminder(text) }] }];
			const { byCall } = liftAddenda(stored, carried);
			expect(byCall.get("t")).toEqual(names);
			const lifted = withToolAdditions(payload(names), byCall, carried)!;
			const system = (lifted.payload.messages as Array<{ content: Array<{ type: string; text?: string; tool?: { name: string } }> }>)[3];
			expect(system.content.filter((part) => part.type === "tool_addition").map((part) => part.tool?.name)).toEqual(names);
			expect(system.content[0].text).toBe([TOOLS_AVAILABLE, ...names].join("\n"));
			const out = stabilizeDeferredTools(lifted.payload, registry, isDeferred, new Map(), new Set(lifted.names))!;
			const tools = out.tools as Array<{ name: string; defer_loading?: boolean }>;
			for (const name of names) expect(tools.find((tool) => tool.name === name)?.defer_loading).toBe(true);
			expect(tools.filter((tool) => tool.defer_loading !== true).map((tool) => tool.name)).toEqual(["read"]);
		});
	});

	it("takes a late batch's names from its facts when a line carries the tool owner's hint", () => {
		const names = ["late_echo", "mcp__s__plain"];
		const text = deferredAddendumText(names, {}, (name) => (name === "late_echo" ? "When you echo, use it." : undefined));
		expect(text.split("\n").slice(1)).toEqual(["late_echo: When you echo, use it.", "mcp__s__plain"]);
		const carried = carriedAddenda([{ text, facts: [{ kind: "tools", names, callable: true }] }]);
		expect(addendumNames(wrapReminder(text), carried)).toEqual(names);
		const stored = [{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "done" }, { type: "text", text: wrapReminder(text) }] }];
		expect(liftAddenda(stored, carried).byCall.get("t")).toEqual(names);
	});

	it("references a batch added after pi renamed the eager tools, under the names the request carries", () => {
		const registry = [
			{ name: "read", parameters: { properties: {} } },
			{ name: "bash", parameters: { properties: {} } },
			{ name: "mcp__s__a", description: "A", parameters: { properties: {} } },
			{ name: "mcp__s__b", description: "B", parameters: { properties: {} } },
		];
		const isDeferred = (name: string) => name.startsWith("mcp__");
		// pi rendered the announced tools eager after its renamed ones; the call that answered carries the addendum.
		const payload = {
			tools: [{ name: "Read", input_schema: {} }, { name: "Bash", input_schema: {} }, { name: "mcp__s__a", input_schema: {} }, { name: "mcp__s__b", input_schema: {} }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
			],
		};
		const lifted = withToolAdditions(payload, new Map([["t", ["mcp__s__a", "mcp__s__b"]]]))!;
		const out = stabilizeDeferredTools(lifted.payload, registry, isDeferred, new Map(), new Set(lifted.names))!;
		expect(out.tools).toEqual([
			{ name: "Read", input_schema: {} },
			{ name: "Bash", input_schema: {} },
			{ name: "mcp__s__a", description: "A", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true },
			{ name: "mcp__s__b", description: "B", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true },
		]);
		expect((out.messages as unknown[])[3]).toEqual({
			role: "system",
			content: [
				{ type: "text", text: `${TOOLS_AVAILABLE}\nmcp__s__a\nmcp__s__b` },
				{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__s__a" } },
				{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__s__b" } },
			],
		});
	});

	it("is declared deferred in tools once added, even though pi rendered it eager", () => {
		const registry = [
			{ name: "read", parameters: { properties: {} } },
			{ name: "mcp__s__a", description: "A", parameters: { properties: {} } },
		];
		const payload = { tools: [{ name: "read", input_schema: {} }, { name: "mcp__s__a", input_schema: {} }], messages: [] };
		const out = stabilizeDeferredTools(payload, registry, (name) => name === "mcp__s__a", new Map(), new Set(["mcp__s__a"]))!;
		expect(out.tools).toEqual([
			{ name: "read", input_schema: {} },
			{ name: "mcp__s__a", description: "A", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true },
		]);
	});
});
