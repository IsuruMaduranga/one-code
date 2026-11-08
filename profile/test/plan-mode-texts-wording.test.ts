/**
 * One Code's plan-mode tool texts: Claude Code's EnterPlanMode description on
 * frontier and workhorse models and One Code's on cheap and tiny ones, Claude
 * Code's ExitPlanMode description, and its enter, approve and reject results.
 * The base's plan-mode-texts.test.ts checks where plan mode puts each text.
 */
import { describe, expect, it } from "vitest";
import { descriptionForm } from "../../extensions/lib/tool-variants.ts";
import { userDenialText } from "../../extensions/lib/user-denial.ts";
import {
	approvedPlanText,
	ENTER_PLAN_MODE_DESCRIPTION,
	ENTER_PLAN_MODE_DESCRIPTION_WEAK,
	enteredPlanModeText,
	enterPlanModeDescription,
	EXIT_PLAN_MODE_DESCRIPTION,
	exitedPlanModeText,
} from "../text/plan-mode/texts.ts";
import { PROMPT_TIERS } from "../../extensions/lib/model-tier.ts";

describe("plan-mode tool descriptions", () => {
	it("enter_plan_mode carries Claude Code's description on frontier and workhorse, One Code's on cheap and tiny", () => {
		for (const tier of PROMPT_TIERS) {
			expect(enterPlanModeDescription(descriptionForm(tier)), tier).toBe(tier === "cheap" || tier === "tiny" ? ENTER_PLAN_MODE_DESCRIPTION_WEAK : ENTER_PLAN_MODE_DESCRIPTION);
		}
	});

	it("Claude Code's enter_plan_mode text prefers plan mode, with One Code's tool names", () => {
		const text = ENTER_PLAN_MODE_DESCRIPTION;
		expect(
			text.startsWith(
				"Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n## When to Use This Tool\n\n**Prefer using enter_plan_mode** for implementation tasks unless they're simple.",
			),
		).toBe(true);
		expect(text).toContain("   - If you would use ask_user_question to clarify the approach, use enter_plan_mode instead\n");
		expect(text).toContain("1. Thoroughly explore the codebase using `find`, `grep`, and read\n");
		expect(text).toContain("6. Exit plan mode with exit_plan_mode when ready to implement\n");
		expect(text.endsWith("- Users appreciate being consulted before significant changes are made to their codebase\n")).toBe(true);
		for (const name of ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "Glob", "Grep"]) expect(text).not.toContain(name);
		expect(text).toHaveLength(4017);
	});

	it("One Code's text for weak models still says most tasks do not need plan mode", () => {
		expect(ENTER_PLAN_MODE_DESCRIPTION_WEAK).toContain("Most tasks do not need it.");
	});

	it("exit_plan_mode carries Claude Code's description with One Code's tool names", () => {
		const text = EXIT_PLAN_MODE_DESCRIPTION;
		expect(
			text.startsWith(
				"Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\n\n## How This Tool Works\n- You should have already written your plan to the plan file specified in the plan mode system message\n",
			),
		).toBe(true);
		expect(text).toContain(
			'**Important:** Do NOT use ask_user_question to ask "Is this plan okay?" or "Should I proceed?" - that\'s exactly what THIS tool does. exit_plan_mode inherently requests user approval of your plan.\n',
		);
		expect(text).not.toContain("AskUserQuestion");
		expect(text).toHaveLength(1857);
	});
});

describe("plan-mode results", () => {
	it("enter_plan_mode returns Claude Code's text and names the plan file", () => {
		expect(enteredPlanModeText("/p/plan.md")).toBe(
			"Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase to understand existing patterns\n2. Identify similar features and architectural approaches\n3. Consider multiple approaches and their trade-offs\n4. Use ask_user_question if you need to clarify the approach\n5. Design a concrete implementation strategy\n6. When ready, use exit_plan_mode to present your plan for approval\n\nRemember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.\n\nYour plan file is /p/plan.md, the one file you may write: build your plan there.",
		);
	});

	it("an approval tells the model to start coding and repeats the plan", () => {
		expect(approvedPlanText("/p/plan.md", "# Plan\n\n1. do it\n")).toBe(
			"User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: /p/plan.md\nYou can refer back to it if needed during implementation.\n\n## Approved Plan:\n# Plan\n\n1. do it\n",
		);
		expect(exitedPlanModeText("/p/plan.md")).toBe(
			"## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions. The plan file is located at /p/plan.md if you need to reference it.",
		);
	});

	it("a rejection is Claude Code's denial text, with the user's words when they typed some", () => {
		expect(userDenialText()).toBe(
			"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.",
		);
		expect(userDenialText("  Use tabs.  ")).toBe(
			"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nUse tabs.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.",
		);
		expect(userDenialText("   ")).toBe(userDenialText());
	});
});
