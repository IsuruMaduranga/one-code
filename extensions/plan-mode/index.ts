/**
 * plan-mode extension — Claude Code's EnterPlanMode / ExitPlanMode tools,
 * file-based: the plan lives at ~/.onecode/plans/<slug>.md, the one path plan
 * mode may write. The path is announced to the model in an every-turn reminder
 * and to the permissions extension over the event bus, and exit_plan_mode
 * reads the file rather than taking the plan as a parameter.
 *
 * Mode state is owned by the permissions extension; this extension requests
 * changes over MODE_CHANNEL and reacts to transitions it observes on
 * PERMISSION_STATUS_CHANNEL (which fires on every setMode). Plan-file
 * allocation happens lazily in before_agent_start — the one hook that covers
 * all three ways into plan mode (the tool, ctrl+q, defaultMode: "plan") and
 * runs after every extension's session_start, so restoring a previous path
 * from the session branch can never race a fresh allocation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { oneCodeStateDir } from "../lib/paths.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { ccToolRenderers, safeThemePaint } from "../lib/tui-render.ts";
import type { PermissionMode } from "../permissions/matcher.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../permissions/modes.ts";
import { buildPlanModeReminder } from "./reminder.ts";
import { randomSlug } from "./slug.ts";
import { clampOffset, decodeViewerKey, initialPlanChoice, type PlanChoice, renderPlanViewer, wrapPlanText } from "./viewer.ts";

import { MODE_CHANNEL, PLAN_FILE_CHANNEL } from "../lib/plan-mode-channels.ts";
export { MODE_CHANNEL, PLAN_FILE_CHANNEL };
/** Session entry type persisting the allocated path across resume/branch. */
const PLAN_FILE_ENTRY = "plan-mode-file";

const PLANS_DIR = () => join(oneCodeStateDir(), "plans");

export default function planModeExtension(pi: ExtensionAPI) {
	let currentMode = "default";
	let planFilePath: string | undefined;

	/** Restore the branch's plan file, else allocate a fresh slug. */
	const ensurePlanFile = (ctx: ExtensionContext): string => {
		if (planFilePath) return planFilePath;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== PLAN_FILE_ENTRY) continue;
			const path = (entry.data as { path?: unknown } | undefined)?.path;
			if (typeof path === "string") planFilePath = path;
		}
		if (planFilePath) return planFilePath;

		let path = join(PLANS_DIR(), `${randomSlug()}.md`);
		for (let attempt = 0; attempt < 5 && existsSync(path); attempt++) {
			path = join(PLANS_DIR(), `${randomSlug()}.md`);
		}
		planFilePath = path;
		pi.appendEntry(PLAN_FILE_ENTRY, { path });
		return path;
	};

	/** Re-announce path + reminder; every-turn re-emits replace by key. */
	const refresh = (ctx: ExtensionContext) => {
		const path = ensurePlanFile(ctx);
		pi.events.emit(PLAN_FILE_CHANNEL, { path });
		pi.events.emit(REMINDER_CHANNEL, {
			text: buildPlanModeReminder({ filePath: path, fileExists: existsSync(path) }),
			scope: "every-turn",
			key: "permission-mode",
		});
	};

	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		const status = data as PermissionStatus;
		if (typeof status?.mode === "string") currentMode = status.mode;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (currentMode === "plan") refresh(ctx);
	});

	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter plan mode",
		...ccToolRenderers("Enter plan mode"),
		description:
			"Enter plan mode: read-only investigation to design an approach before changing anything. Most tasks do not need it.\n" +
			"For a small or clearly-scoped change, act directly instead. Enter plan mode only for multi-file work whose design is genuinely unclear, or when the user asks for a plan. In plan mode only read-only tools are available, plus one writable file: the plan file whose path you are told, where you build the plan incrementally.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			pi.events.emit(MODE_CHANNEL, { mode: "plan" });
			// setMode fires synchronously over the status channel, so currentMode
			// is already "plan"; announce the file in the tool result too so the
			// model can start writing this same turn.
			const path = ensurePlanFile(ctx);
			refresh(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Entered plan mode. Only read-only tools are available, except for your plan file at ${path} — build your plan there incrementally, then call exit_plan_mode to request approval.`,
					},
				],
				details: { planFilePath: path },
			};
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		...ccToolRenderers("Exit plan mode"),
		description:
			"Signal that planning is complete and ask the user to approve the plan.\n" +
			"Takes no parameters: the plan is read from the plan file named in the plan-mode reminder, which you must have written before calling this. The user reviews that file's contents.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			// Guard the out-of-sequence call: without this, a cold exit_plan_mode
			// (never entered plan mode) allocates a fresh empty plan file and blames
			// "the plan file is empty" — a plausible but wrong cause a weak model
			// then chases. The real fix is to enter plan mode first.
			if (currentMode !== "plan") {
				return {
					content: [
						{
							type: "text",
							text: "Not in plan mode, so there is no plan to approve. Call enter_plan_mode first, build the plan in the file it names, then call exit_plan_mode.",
						},
					],
					details: {},
					isError: true,
				};
			}
			const path = ensurePlanFile(ctx);
			const plan = existsSync(path) ? readFileSync(path, "utf8") : "";
			if (!plan.trim()) {
				return {
					content: [
						{
							type: "text",
							text: `No plan to approve: ${path} is missing or empty. Write your plan there first, then call exit_plan_mode again.`,
						},
					],
					details: { planFilePath: path },
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				pi.events.emit(MODE_CHANNEL, { mode: "default" });
				return {
					content: [
						{ type: "text", text: "Non-interactive session: plan recorded and plan mode exited. Proceed." },
					],
					details: { plan, approved: true },
				};
			}

			// Auto mode leads the list when a classifier model is reachable — the
			// same gate the mode cycle uses (permissions/index.ts autoInCycle). Each
			// approving choice carries the mode it switches to; the final "Keep
			// planning" choice has none and leaves the session in plan mode.
			const autoAvailable = ctx.modelRegistry.getAvailable().length > 0;
			const options: { label: string; mode?: PermissionMode }[] = [
				...(autoAvailable ? [{ label: "Approve — auto mode", mode: "auto" as const }] : []),
				{ label: "Approve — auto-accept edits", mode: "acceptEdits" },
				{ label: "Approve — manual approvals", mode: "default" },
				{ label: "Keep planning" },
			];
			const choices = options.map((o) => o.label);

			const choice = await ctx.ui.custom<PlanChoice | null>((tui, theme, _keybindings, done) => {
				const paint = safeThemePaint(theme);
				const maxVisible = 12;
				let offset = 0;
				let selected: PlanChoice = initialPlanChoice(options);
				let lineCount = 0;
				return {
					render: (width: number) => {
						const lines = wrapPlanText(plan, Math.max(10, width - 1));
						lineCount = lines.length;
						offset = clampOffset(offset, lineCount, maxVisible);
						return renderPlanViewer({ lines, offset, choice: selected, choices, maxVisible }, paint, width);
					},
					handleInput: (data: string) => {
						const key = decodeViewerKey(data, maxVisible);
						if (!key) return;
						if (key.kind === "cancel") return done(null);
						if (key.kind === "confirm") return done(selected);
						if (key.kind === "pick") return key.index < options.length ? done(key.index) : undefined;
						if (key.kind === "scroll") offset = clampOffset(offset + key.delta, lineCount, maxVisible);
						else if (key.kind === "choice")
							selected = (((selected + key.delta) % options.length) + options.length) % options.length;
						tui.requestRender();
					},
					invalidate: () => {},
				};
			});

			const picked = choice != null ? options[choice] : undefined;
			if (picked?.mode) {
				pi.events.emit(MODE_CHANNEL, { mode: picked.mode });
				return {
					content: [
						{
							type: "text",
							text: `Plan approved by the user. You may now implement it. The approved plan stays at ${path} for reference.`,
						},
					],
					details: { plan, approved: true },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "The user did not approve the plan. Stay in plan mode; refine the plan file based on their feedback.",
					},
				],
				details: { plan, approved: false },
			};
		},
	});

	// Claude Code defers both plan-mode tools behind ToolSearch: they are absent
	// from the wire tool list and its system prompt never mentions plan mode, so
	// the model must deliberately load them before planning. Keeping them
	// always-active (with a prompt snippet) read as standing "plan first" policy
	// to instruction-eager third-party models, which then entered plan mode for
	// trivial tasks. User-initiated plan mode (mode cycling, defaultMode) is
	// unaffected — that flows over MODE_CHANNEL, not through these tools.
	pi.events.emit(DEFER_CHANNEL, {
		name: "enter_plan_mode",
		keywords: ["plan", "planning", "design", "approach", "architecture", "investigate", "read-only"],
	});
	pi.events.emit(DEFER_CHANNEL, {
		name: "exit_plan_mode",
		keywords: ["plan", "approve", "approval", "present", "finish planning"],
	});
}
