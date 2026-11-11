/**
 * What plan mode needs from a profile (types only). The extension owns the
 * mode, the plan file and the approval dialog's choices; the profile words
 * what the model reads (working-docs/features/profiles/).
 */

import type { DescriptionForm } from "../../lib/profile/tool-variants.ts";
import { type LiveTools, type ToolPassages, withoutOff } from "../../lib/profile/live-tools.ts";
import { forLive } from "../../lib/profile/live-words.ts";

export interface PlanModeText {
	descriptions: {
		/** Short on frontier and workhorse, long on cheap and tiny (lib/profile/tool-variants.ts). */
		enter_plan_mode(form: DescriptionForm): string;
		exit_plan_mode: string;
	};
	/**
	 * The plan-mode block carried while the mode lasts. `planExists` is decided
	 * once when the mode comes on, so the text does not flip while it lasts
	 * (the block is anchored; a flip re-caches every message after it).
	 */
	reminder(p: { planFile: string; planExists: boolean }): string;
}

/** The group's results, refusals and notes, which the base words (`planModeResultText`). */
export interface PlanModeResultText {
	/** enter_plan_mode's result. */
	entered(planFile: string): string;
	/** exit_plan_mode called outside plan mode. */
	notInPlanMode: string;
	/** exit_plan_mode with a missing or empty plan file. */
	emptyPlan(planFile: string): string;
	/** exit_plan_mode in a session with no user to approve; it stays in plan mode. */
	noApprover(planFile: string): string;
	/** exit_plan_mode's result once the user approves. */
	approved(p: { planFile: string; plan: string }): string;
	/** The reminder after the approval: plan mode is over. */
	exited(planFile: string): string;
	/**
	 * The plan re-attached after a compaction. `content` is left out when the
	 * plan is too large to inline (`chars` long), so the model reads the file.
	 */
	reattached(p: { planFile: string; content?: string; chars: number }): string;
}

/** Claude Code's EnterPlanMode result. */
const ENTERED_PLAN_MODE = [
	"Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
	"",
	"In plan mode, you should:",
	"1. Thoroughly explore the codebase to understand existing patterns",
	"2. Identify similar features and architectural approaches",
	"3. Consider multiple approaches and their trade-offs",
	"4. Use ask_user_question if you need to clarify the approach",
	"5. Design a concrete implementation strategy",
	"6. When ready, use exit_plan_mode to present your plan for approval",
	"",
	"Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.",
].join("\n");

/**
 * enter_plan_mode's result: Claude Code's text, then the plan file's path so
 * the model can start writing the plan in the same turn.
 */
export function enteredPlanModeText(planFilePath: string): string {
	return `${ENTERED_PLAN_MODE}\n\nYour plan file is ${planFilePath}, the one file you may write: build your plan there.`;
}

/** exit_plan_mode's result when the user approves: Claude Code's text, with the plan file's contents. */
export function approvedPlanText(planFilePath: string, plan: string): string {
	return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: ${planFilePath}\nYou can refer back to it if needed during implementation.\n\n## Approved Plan:\n${plan}`;
}

/** Claude Code's reminder after the approval: plan mode is over and the plan file stays readable. */
export function exitedPlanModeText(planFilePath: string): string {
	return `## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions. The plan file is located at ${planFilePath} if you need to reference it.`;
}

const CONTINUE = "If this plan is relevant to the current work and not already complete, continue working on it.";

const ENTERED_PASSAGES: ToolPassages = {
	ask_user_question: ["4. Use ask_user_question if you need to clarify the approach\n"],
};

/** The base's words of the group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const planModeResultWords = (live: LiveTools): PlanModeResultText => ({
	entered: (planFile) => withoutOff(enteredPlanModeText(planFile), live, ENTERED_PASSAGES),
	notInPlanMode: "Not in plan mode, so there is no plan to approve. Call enter_plan_mode first, build the plan in the file it names, then call exit_plan_mode.",
	emptyPlan: (planFile) => `No plan to approve: ${planFile} is missing or empty. Write your plan there first, then call exit_plan_mode again.`,
	noApprover: (planFile) =>
		`Plan approval needs an interactive session, and this one has no user to approve it. The session stays in plan mode; the plan is recorded at ${planFile} for the user to review. Do not try to implement it here.`,
	approved: ({ planFile, plan }) => approvedPlanText(planFile, plan),
	exited: exitedPlanModeText,
	reattached: ({ planFile, content, chars }) =>
		content === undefined
			? `A plan file exists from plan mode at: ${planFile}\n\nIt is too large to include here (${chars.toLocaleString("en-US")} characters); read it before continuing.\n\n${CONTINUE}`
			: `A plan file exists from plan mode at: ${planFile}\n\nPlan contents:\n\n${content}\n\n${CONTINUE}`,
});

/** The words for this session's tools. */
export const planModeResultText = forLive(planModeResultWords);
