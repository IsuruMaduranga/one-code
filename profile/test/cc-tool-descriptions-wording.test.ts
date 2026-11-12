/**
 * One Code's tool texts, per tier and permission mode: Claude Code's, each
 * locked by its length and a hash so an accidental edit shows up here, with
 * One Code's tool names in place of Claude Code's. How the base picks a form
 * is test/unit/cc-tool-descriptions.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ASK_LONG_DESCRIPTION, ASK_SHORT_DESCRIPTION } from "../text/ask-user/description.ts";
import { BASH_AVOID_SHELL_READS_LINE, BASH_LONG_DESCRIPTION, BASH_LONG_SEARCH_TOOLS_DESCRIPTION, BASH_SHORT_DESCRIPTION, bashDescription } from "../text/shell/bash-description.ts";
import { NOTEBOOK_EDIT_DESCRIPTION } from "../text/notebook/description.ts";
import { AGENT_HOW_AGENTS_RUN, AGENT_LONG_DESCRIPTION, AGENT_SHORT_DESCRIPTION, agentDescription } from "../text/subagents/agent-description.ts";
import { TASK_CREATE_DESCRIPTION, TASK_GET_DESCRIPTION, TASK_LIST_DESCRIPTION, TASK_UPDATE_DESCRIPTION } from "../text/tasks/descriptions.ts";
import { WRITE_LONG_DESCRIPTION, WRITE_SHORT_DESCRIPTION } from "../text/tool-style/index.ts";
import { WEB_SEARCH_LONG_DESCRIPTION } from "../text/web-search/description.ts";
import { WEB_FETCH_LONG_DESCRIPTION } from "../text/web-fetch/description.ts";
import { ENTER_WORKTREE_DESCRIPTION, EXIT_WORKTREE_DESCRIPTION } from "../text/worktree/descriptions.ts";
import { sha } from "./helpers/sha.ts";

describe("the shipped texts", () => {
	it.each([
		["Bash short, auto mode", bashDescription("short", true), 1021, "ffaa03fd9f7cc324"],
		["Bash short, other modes", bashDescription("short", false), 1331, "3c6af5ed508abb0f"],
		["Bash long", BASH_LONG_DESCRIPTION, 10117, "150cfe7f15de9c0f"],
		["Agent short (Claude Code's part)", AGENT_SHORT_DESCRIPTION, 1796, "00816e142144127f"],
		["Agent long (Claude Code's part)", AGENT_LONG_DESCRIPTION, 7054, "8688abf39f02eb87"],
		["Write short", WRITE_SHORT_DESCRIPTION, 240, "6b258dbec215234d"],
		["Write long", WRITE_LONG_DESCRIPTION, 618, "abb9cbaad9e678a9"],
		["AskUserQuestion short", ASK_SHORT_DESCRIPTION, 1760, "28629d142d565b3f"],
		["AskUserQuestion long", ASK_LONG_DESCRIPTION, 1505, "0251bfa975d4b3f9"],
		["WebFetch long", WEB_FETCH_LONG_DESCRIPTION, 1653, "332637519274c002"],
		["WebSearch long", WEB_SEARCH_LONG_DESCRIPTION, 1473, "e552812379795d9b"],
		["NotebookEdit", NOTEBOOK_EDIT_DESCRIPTION, 803, "5a701ed8db42b168"],
		["TaskCreate", TASK_CREATE_DESCRIPTION, 2148, "031fab8e56dfee27"],
		["TaskUpdate", TASK_UPDATE_DESCRIPTION, 2245, "d0d6e2f7e19354e7"],
		["TaskGet", TASK_GET_DESCRIPTION, 733, "4158d4726eb58d59"],
		["TaskList", TASK_LIST_DESCRIPTION, 1001, "87e632e37738bf17"],
		["EnterWorktree", ENTER_WORKTREE_DESCRIPTION, 2179, "58fec66cb2bdb541"],
		["ExitWorktree", EXIT_WORKTREE_DESCRIPTION, 1773, "c559deab629a0b43"],
	])("%s", (_name, text, length, hash) => {
		expect(text.length).toBe(length);
		expect(sha(text)).toBe(hash);
	});

	it("Bash: the short form drops only the avoid-cat bullet in auto mode; the long form ignores the mode", () => {
		expect(BASH_SHORT_DESCRIPTION).toContain(BASH_AVOID_SHELL_READS_LINE);
		expect(bashDescription("short", true)).not.toContain("IMPORTANT: Avoid using this tool");
		expect(bashDescription("short", false).replace(BASH_AVOID_SHELL_READS_LINE, "")).toBe(bashDescription("short", true));
		expect(bashDescription("long", true)).toBe(bashDescription("long", false));
	});

	it("never promises a working directory that carries over between calls", () => {
		for (const text of [bashDescription("short", true), bashDescription("short", false), BASH_LONG_DESCRIPTION]) {
			expect(text).not.toMatch(/working directory persists/i);
			expect(text).toMatch(/starts in the session's working directory/);
		}
	});

	it("Agent: One Code's paragraph follows Claude Code's text in both forms", () => {
		expect(agentDescription("short")).toBe(`${AGENT_SHORT_DESCRIPTION}\n\n${AGENT_HOW_AGENTS_RUN}`);
		expect(agentDescription("long")).toBe(`${AGENT_LONG_DESCRIPTION.trimEnd()}\n\n${AGENT_HOW_AGENTS_RUN}`);
		expect(AGENT_HOW_AGENTS_RUN).toContain("task_output");
		expect(AGENT_HOW_AGENTS_RUN).toContain('`action: "list"`');
	});

	it("names One Code's tools, not Claude Code's", () => {
		const texts = [bashDescription("short", false), BASH_LONG_DESCRIPTION, WRITE_SHORT_DESCRIPTION, WRITE_LONG_DESCRIPTION, ASK_SHORT_DESCRIPTION, WEB_FETCH_LONG_DESCRIPTION, TASK_CREATE_DESCRIPTION, TASK_UPDATE_DESCRIPTION, TASK_LIST_DESCRIPTION, ENTER_WORKTREE_DESCRIPTION, EXIT_WORKTREE_DESCRIPTION];
		for (const text of texts) {
			expect(text).not.toMatch(/\b(Monitor|TaskCreate|TaskUpdate|TaskGet|TaskList|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree|WebFetch)\b/);
			expect(text).not.toMatch(/\bUse (Read|Edit|Write)\b|the (Read|Edit|Write|Bash) tool\b/);
		}
	});

	it("on tiny, the long form points at the search tools instead of shell find; cheap keeps Claude Code's text", () => {
		expect(BASH_LONG_DESCRIPTION).toContain("When running `find`");
		expect(BASH_LONG_SEARCH_TOOLS_DESCRIPTION).not.toContain("`find`");
		expect(BASH_LONG_SEARCH_TOOLS_DESCRIPTION).toContain("the find tool for files, the grep tool for content, the ls tool");
		expect(bashDescription("short", false, true)).toBe(bashDescription("short", false));
	});
});
