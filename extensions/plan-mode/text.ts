/**
 * What plan mode needs from a profile (types only). The extension owns the
 * mode, the plan file and the approval dialog's choices; the profile words
 * what the model reads (working-docs/features/profiles/).
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";
import type { LiveTools } from "../lib/live-tools.ts";

export interface PlanModeText {
	descriptions: {
		/** Short on frontier and workhorse, long on cheap and tiny (lib/tool-variants.ts). */
		enter_plan_mode(form: DescriptionForm, live: LiveTools): string;
		exit_plan_mode(live: LiveTools): string;
	};
	/**
	 * The plan-mode block carried while the mode lasts. `planExists` is decided
	 * once when the mode comes on, so the text does not flip while it lasts
	 * (the block is anchored; a flip re-caches every message after it).
	 */
	reminder(p: { planFile: string; planExists: boolean }): string;
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
