/**
 * One Code's plan-mode wording (profile/text/plan-mode/): the plan-mode block
 * (Claude Code's plan-mode instructions with One Code's tool and agent
 * names), and the results the golden session cannot reach: no user to
 * approve, and a plan too large to re-attach. The golden snapshot pins the
 * bytes of every other text. The base's plan-mode.test.ts checks the plan
 * file's name and the approval dialog.
 */
import { describe, expect, it } from "vitest";
import { buildPlanModeReminder } from "../text/plan-mode/reminder.ts";
import { planModeResultText } from "../../extensions/safety/plan-mode/text.ts";


describe("One Code's plan-mode text", () => {
	it("keeps a session with no user in plan mode and says so", () => {
		expect(planModeResultText().noApprover("/p/plan.md")).toBe(
			"Plan approval needs an interactive session, and this one has no user to approve it. The session stays in plan mode; the plan is recorded at /p/plan.md for the user to review. Do not try to implement it here.",
		);
	});

	it("names a plan too large to re-attach instead of inlining it", () => {
		expect(planModeResultText().reattached({ planFile: "/p/plan.md", chars: 50_000 })).toBe(
			"A plan file exists from plan mode at: /p/plan.md\n\nIt is too large to include here (50,000 characters); read it before continuing.\n\nIf this plan is relevant to the current work and not already complete, continue working on it.",
		);
		expect(planModeResultText().reattached({ planFile: "/p/plan.md", content: "# Plan", chars: 6 })).toContain("Plan contents:\n\n# Plan\n\n");
	});
});

describe("buildPlanModeReminder", () => {
	const path = "/home/u/.onecode/plans/brisk-otter-map.md";

	it("is byte-stable for a path and file state (the sticky block must not re-anchor)", () => {
		expect(buildPlanModeReminder(path, false)).toBe(buildPlanModeReminder(path, false));
		expect(buildPlanModeReminder(path, true)).toBe(buildPlanModeReminder(path, true));
	});

	it("opens with Claude Code's text and its Plan File Info line for each file state", () => {
		const head =
			"Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.\n\n## Plan File Info:\n";
		const tail =
			"\nYou should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.\n\n## Plan Workflow\n\n### Phase 1: Initial Understanding\n";
		expect(buildPlanModeReminder(path, false).startsWith(`${head}No plan file exists yet. You should create your plan at ${path} using the write tool.${tail}`)).toBe(true);
		expect(
			buildPlanModeReminder(path, true).startsWith(
				`${head}A plan file already exists at ${path}. You can read it and make incremental edits using the edit tool.${tail}`,
			),
		).toBe(true);
	});

	it("carries the five phases with One Code's tool and agent names, and ends on Claude Code's closing note", () => {
		const text = buildPlanModeReminder(path, false);
		const phases = text.split("\n").filter((line) => line.startsWith("### Phase"));
		expect(phases).toEqual([
			"### Phase 1: Initial Understanding",
			"### Phase 2: Design",
			"### Phase 3: Review",
			"### Phase 4: Final Plan",
			"### Phase 5: Call exit_plan_mode",
		]);
		expect(text).toContain("Critical: In this phase you should only use the explore subagent type.");
		expect(text).toContain("2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.");
		expect(text).toContain("Launch plan agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.");
		expect(text).toContain("3. Use ask_user_question to clarify any remaining questions with the user");
		expect(text).toContain(
			"This is critical - your turn should only end with either using the ask_user_question tool OR calling exit_plan_mode. Do not stop unless it's for these 2 reasons",
		);
		expect(
			text.endsWith(
				"NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ask_user_question tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.",
			),
		).toBe(true);
		// Claude Code's PascalCase names never leak through.
		for (const name of ["AskUserQuestion", "ExitPlanMode", "Write tool", "Explore", "Plan agent"]) expect(text).not.toContain(name);
		// Claude Code's text with only the names changed: 5,395 characters around the path.
		expect(text).toHaveLength(5395 + path.length);
	});
});
