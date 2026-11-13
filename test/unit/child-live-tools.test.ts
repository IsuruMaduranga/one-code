/**
 * A child session's own tool set (lib/agents/child-extensions.ts): the words
 * of the tools a child registers name only what every child has. A child
 * loads no background, task, plan-mode, ask-user or workflow extension, so
 * the main session's words would send it to tools it lacks.
 */
import { describe, expect, it } from "vitest";
import { childLive, childShellWords, childText } from "../../extensions/lib/agents/child-extensions.ts";
import { TOOL_FEATURES } from "../../extensions/lib/profile/features.ts";
import { activeProfile } from "../../extensions/lib/profile/profile.ts";
import { bashGuardReason } from "../../extensions/lib/shell/bash-guards.ts";
import { mentions } from "./helpers/tool-mentions.ts";

/** The tools no child loads the feature of. */
const ABSENT = ["monitor", "schedule_wakeup", "task_output", "task_stop", "cron_create", "ask_user_question", "enter_plan_mode", "exit_plan_mode", "task_create", "task_update", "workflow", "lsp_diagnostics", "artifact"];

describe("a child session's tools", () => {
	it("are the live tools whose feature a child loads", () => {
		const live = childLive();
		for (const tool of ABSENT) expect(live.has(tool), tool).toBe(false);
		for (const tool of ["bash", "skill", "web_fetch", "web_search", "notebook_edit", "read", "edit"]) expect(live.has(tool), tool).toBe(activeProfile().live.has(tool));
		// A subagent is handed these two; the commit rules must still forbid the first.
		for (const tool of ["Agent", "SendMessage"]) expect(live.has(tool), tool).toBe(activeProfile().live.has(tool));
		// Never more than the main session's.
		for (const tool of Object.keys(TOOL_FEATURES)) expect(live.has(tool) && !activeProfile().live.has(tool), tool).toBe(false);
	});

	it("word the shell tools without the tools a child lacks", () => {
		const shell = childText().shell;
		if (!shell) return; // a profile without shell tools
		const texts = [
			...(["short", "long"] as const).flatMap((form) => [true, false].map((autoMode) => shell.bashDescription({ form, autoMode, searchTools: false }))),
			...(["core", "desktop", "unknown"] as const).map((edition) => shell.powershellDescription({ edition })),
			childShellWords().blocked({ kind: "sleep", shown: "sleep 30", sleepName: "sleep", untilExample: "until test -f x; do sleep 2; done" }),
			childShellWords().blocked({ kind: "consolePrompt", command: "Read-Host" }),
			childShellWords().backgroundStarted({ label: "Bash", id: "b1", description: "d", logPath: "/l" }),
		];
		for (const text of texts) for (const tool of ABSENT) expect(mentions(text, tool, { monitor: [/monitor for regressions/] }), tool).toEqual([]);
	});

	it("refuse a command in the words the session is given", () => {
		const child = bashGuardReason("sleep 60", { background: false, words: childShellWords() });
		const main = bashGuardReason("sleep 60", { background: false });
		expect(child).toBeDefined();
		expect(child).not.toContain("monitor");
		if (activeProfile().live.has("monitor")) expect(main).toContain("monitor");
	});
});
