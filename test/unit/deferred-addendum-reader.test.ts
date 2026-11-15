import { describe, expect, it } from "vitest";
import { deferredAddendumText } from "../../extensions/lib/request/deferred.ts";
import { wrapReminder } from "../../extensions/lib/request/reminders.ts";
// @ts-expect-error The standalone E2E checker is intentionally plain JavaScript.
import { addendumLines, announcements } from "../e2e/deferred-addendum.mjs";

/** An addendum for `a`, `b` (hinted) and `c`, framed as on the wire. */
const addendum = wrapReminder(deferredAddendumText(["a_tool", "b_tool", "c_tool"], {}, (name) => (name === "b_tool" ? "Does the b thing." : undefined)));

describe("deferred-addendum reader (transition-check, cache-probe)", () => {
	it("reads every tool line, a hinted one included, and stops at the reminder's end", () => {
		expect(addendumLines(`before\n${addendum}\nafter`)).toEqual(["a_tool", "b_tool: Does the b thing.", "c_tool"]);
	});

	it.each([
		["a user message's string content", { role: "user", content: addendum }],
		["a text block", { role: "user", content: [{ type: "text", text: addendum }] }],
		["a tool result's string content", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `output\n${addendum}` }] }],
		["a tool result's block content", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `output\n${addendum}` }] }] }],
	])("counts each tool once in %s", (_label, message) => {
		expect(Object.fromEntries(announcements([message]))).toEqual({ a_tool: 1, b_tool: 1, c_tool: 1 });
	});

	it("counts a tool_addition block instead of reading text in the same message", () => {
		const message = { role: "system", content: [{ type: "tool_addition", tool: { name: "a_tool" } }, { type: "text", text: addendum }] };
		expect(Object.fromEntries(announcements([message]))).toEqual({ a_tool: 1 });
	});

	it("counts a tool announced twice across messages twice", () => {
		const message = { role: "user", content: addendum };
		expect(announcements([message, message]).get("b_tool")).toBe(2);
	});
});
