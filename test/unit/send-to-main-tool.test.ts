/**
 * agents/subagents/send-to-main-tool.ts: a subagent's SendMessage to the main
 * conversation. In a fork it declares the parent's schema (fork-cache.ts
 * withParentParameters); only "main" is a valid recipient either way.
 */
import { describe, expect, it } from "vitest";
import { sendToMainTool } from "../../extensions/agents/subagents/send-to-main-tool.ts";

type Result = { content: Array<{ text: string }>; isError?: boolean; details: { toMain?: boolean } };

describe("sendToMainTool", () => {
	it("delivers to main and refuses any other recipient", async () => {
		const sent: string[] = [];
		const tool = sendToMainTool((message) => sent.push(message));
		const ok = (await tool.execute("c1", { to: "main", message: "found it" }, undefined, undefined, undefined as never)) as Result;
		expect(ok.isError).toBeUndefined();
		expect(sent).toEqual(["found it"]);
		const wrong = (await tool.execute("c2", { to: "fork-2", message: "hi" }, undefined, undefined, undefined as never)) as Result;
		expect(wrong.isError).toBe(true);
		expect(sent).toEqual(["found it"]);
	});
});
