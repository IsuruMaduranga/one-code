/**
 * plan-mode extension — Claude Code's EnterPlanMode / ExitPlanMode tools.
 *
 * Mode state is owned by the permissions extension; this extension requests
 * changes over the event bus (channel below) and runs the plan-approval
 * dialog when the model exits plan mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MODE_CHANNEL = "pincer:set-permission-mode";

export default function planModeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter plan mode",
		description:
			"Enter plan mode for tasks that need investigation and design before changing anything. In plan mode only read-only tools are available: explore the codebase, then present a plan. Use for non-trivial multi-file work; skip it for simple direct changes.",
		promptSnippet: "enter_plan_mode - switch to read-only planning before non-trivial changes",
		parameters: Type.Object({}),
		async execute() {
			pi.events.emit(MODE_CHANNEL, { mode: "plan" });
			return {
				content: [
					{
						type: "text",
						text: "Entered plan mode. Only read-only tools are available. Investigate, then present your plan and call exit_plan_mode to request approval.",
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		description:
			"Signal that planning is complete and ask the user to approve the plan. Include the full plan in the `plan` parameter (markdown). Only call this after you have presented a concrete implementation plan.",
		promptSnippet: "exit_plan_mode - present your plan for user approval",
		parameters: Type.Object({
			plan: Type.String({ description: "The complete implementation plan (markdown) for the user to review" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				pi.events.emit(MODE_CHANNEL, { mode: "default" });
				return {
					content: [
						{ type: "text", text: "Non-interactive session: plan recorded and plan mode exited. Proceed." },
					],
					details: { plan: params.plan, approved: true },
				};
			}

			const APPROVE = "Approve plan (manual approvals)";
			const APPROVE_EDITS = "Approve plan (auto-accept edits)";
			const REJECT = "Keep planning";
			const choice = await ctx.ui.select(`Approve this plan?\n\n${params.plan}`, [APPROVE, APPROVE_EDITS, REJECT]);

			if (choice === APPROVE || choice === APPROVE_EDITS) {
				pi.events.emit(MODE_CHANNEL, { mode: choice === APPROVE_EDITS ? "acceptEdits" : "default" });
				return {
					content: [{ type: "text", text: "Plan approved by the user. You may now implement it." }],
					details: { plan: params.plan, approved: true },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "The user did not approve the plan. Stay in plan mode; refine the plan based on their feedback.",
					},
				],
				details: { plan: params.plan, approved: false },
			};
		},
	});
}
