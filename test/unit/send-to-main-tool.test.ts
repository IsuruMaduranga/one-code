/**
 * agents/subagents/send-to-main-tool.ts: a subagent's SendMessage to the main
 * conversation. A fork's takes the parent's SendMessage schema, so its ledger
 * keeps the parent's recorded declaration; only "main" is a valid recipient
 * either way.
 */
import { describe, expect, it } from "vitest";
import { sendToMainTool } from "../../extensions/agents/subagents/send-to-main-tool.ts";

type Result = { content: Array<{ text: string }>; isError?: boolean; details: { toMain?: boolean } };

describe("sendToMainTool", () => {
	it("takes the parent's schema when a fork passes it, and its own otherwise", () => {
		const parent = { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"] };
		expect(sendToMainTool(() => {}, parent).parameters).toBe(parent);
		const own = sendToMainTool(() => {}).parameters as { required?: string[] };
		expect(own.required).toEqual(["message"]);
	});

	it("delivers to main and refuses any other recipient, whichever schema it declares", async () => {
		const sent: string[] = [];
		const tool = sendToMainTool((message) => sent.push(message), { type: "object" });
		const ok = (await tool.execute("c1", { to: "main", message: "found it" }, undefined, undefined, undefined as never)) as Result;
		expect(ok.isError).toBeUndefined();
		expect(sent).toEqual(["found it"]);
		const wrong = (await tool.execute("c2", { to: "fork-2", message: "hi" }, undefined, undefined, undefined as never)) as Result;
		expect(wrong.isError).toBe(true);
		expect(sent).toEqual(["found it"]);
	});
});
