/**
 * The deferred-tool listing's profile words: a hint per tool with One Code's
 * tool names, the clauses naming a tool that is off cut, and the closing
 * paragraph on loading a tool the next step needs.
 */
import { describe, expect, it } from "vitest";
import { toolSearchText } from "../text/tool-search/index.ts";

const all = { has: () => true };

describe("the deferred-tool listing words", () => {
	it("hints at when to load each tool, in One Code's tool names", () => {
		const words = toolSearchText(all);
		expect(words.listingHints?.monitor).toBe("When you are about to check a log, process or job again and again to catch each new event, use it and not repeated bash calls or sleeps.");
		expect(words.listingHints?.task_stop).toBe("When you are about to end a background task or a background agent that is still running, use it with the task's id.");
		expect(words.listingHints?.task_output).toBeUndefined();
		for (const hint of Object.values(words.listingHints ?? {})) expect(hint).not.toMatch(/\b(Monitor|Bash|CronCreate|AskUserQuestion|EnterWorktree|ReadMcpResourceTool|scheduled_tasks\.json)\b/);
		expect(words.listingClose).toBe(
			"When the step in front of you is one that an entry in this list is made for, and that tool is not loaded yet, load it as your next step. That holds even if you could do the step another way, with a general tool or in a plain-text reply. Loading runs nothing: it brings the tool's definition into the conversation, and you choose how to do the step once you have read it.",
		);
	});

	it("leaves out the clauses that name a tool the session does not have", () => {
		const words = toolSearchText({ has: (tool) => !["monitor", "bash", "ask_user_question", "read_mcp_resource_dir"].includes(tool) });
		expect(words.listingHints?.cron_create).toBe("When you are about to agree to do something at a set time or at fixed intervals, use it and not a promise in your reply, which nothing would carry out.");
		expect(words.listingHints?.monitor).toContain("not repeated calls or sleeps");
		expect(words.listingHints?.exit_plan_mode).toBe("When you are in plan mode, your plan is ready and you are about to ask whether to proceed, use it and not a question.");
		expect(words.listingHints?.read_mcp_resource).not.toContain("read_mcp_resource_dir");
	});
});
