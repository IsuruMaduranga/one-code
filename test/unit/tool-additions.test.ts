import { describe, expect, it } from "vitest";
import { deferredAddendumText, stabilizeDeferredTools } from "../../extensions/lib/deferred.ts";
import { wrapReminder } from "../../extensions/lib/reminders.ts";
import { addendumNames, addendumNamesOnBranch, supportsToolAdditions, TOOLS_AVAILABLE, withToolAdditions } from "../../extensions/lib/tool-additions.ts";

const framed = wrapReminder(deferredAddendumText(["mcp__s__a", "mcp__s__b"]));

describe("supportsToolAdditions", () => {
	it("needs first-party Anthropic and both of pi's mid-conversation flags", () => {
		const flags = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
		expect(supportsToolAdditions({ provider: "anthropic", api: "anthropic-messages", compat: flags })).toBe(true);
		expect(supportsToolAdditions({ provider: "opencode", api: "anthropic-messages", compat: flags })).toBe(false);
		expect(supportsToolAdditions({ provider: "anthropic", api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true } })).toBe(false);
		expect(supportsToolAdditions(undefined)).toBe(false);
	});
});

describe("withToolAdditions", () => {
	it("lifts an addendum joined onto a tool result into Claude Code's addition message after it", () => {
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t" }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: `done\n${framed}\n<system-reminder>\nnote\n</system-reminder>` }] },
			],
		};
		const out = withToolAdditions(payload)!;
		expect(out.names).toEqual(["mcp__s__a", "mcp__s__b"]);
		const messages = out.payload.messages as unknown[];
		expect(messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done\n<system-reminder>\nnote\n</system-reminder>" }] });
		expect(messages[3]).toEqual({
			role: "system",
			content: [
				{ type: "text", text: `${TOOLS_AVAILABLE}\nmcp__s__a\nmcp__s__b` },
				{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__s__a" } },
				{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__s__b" } },
			],
		});
	});

	it("lifts a pinned addendum block off a user message, and leaves a request without one alone", () => {
		const out = withToolAdditions({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: framed }] }] })!;
		expect((out.payload.messages as Array<{ content: unknown[] }>)[0].content).toEqual([{ type: "text", text: "hi" }]);
		expect(withToolAdditions({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).toBeUndefined();
	});

	it("reads the names back from stored text and from a resumed branch", () => {
		expect(addendumNames(`x\n${framed}`)).toEqual(["mcp__s__a", "mcp__s__b"]);
		const branch = [{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "done" }, { type: "text", text: framed }] } }];
		expect(addendumNamesOnBranch(branch)).toEqual(["mcp__s__a", "mcp__s__b"]);
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
