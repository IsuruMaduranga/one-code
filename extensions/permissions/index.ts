/**
 * permissions extension — Claude Code-style permission system.
 *
 * - Rules from ~/.claude/settings.json + <project>/.claude/settings.json +
 *   settings.local.json (Claude Code format, PascalCase tool names accepted).
 * - Modes: default | acceptEdits | plan | bypassPermissions, set via
 *   --permission-mode / --dangerously-skip-permissions or /permission-mode.
 * - Ask-tier calls prompt Yes / Yes-for-session / No; non-interactive modes
 *   deny with an instructive reason instead of prompting.
 */

import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import {
	decide,
	extractSubject,
	normalizeToolName,
	parseRule,
	parseRules,
	type PermissionMode,
	type PermissionRule,
} from "./matcher.ts";
import { isPermissionMode, loadPermissionSettings, persistAllowRule, settingsPaths } from "./settings.ts";

const DENIED_BY_USER =
	"The user doesn't want to proceed with this tool use. The tool use was rejected. Adjust your approach based on the user's feedback instead of retrying the same call.";
const DENIED_NON_INTERACTIVE =
	"Permission required but this session is non-interactive, so the user cannot approve the call. It was blocked. Only pre-approved tools can run here; work within those, or ask the user to re-run interactively or with an allow rule / --dangerously-skip-permissions.";
const DENIED_PLAN_MODE =
	"You are in plan mode: only read-only tools may run. Do not attempt mutations; present your plan to the user instead.";
const DENIED_BY_RULE = (rule: string) =>
	`This tool call is denied by the permission rule "${rule}" in the user's settings. Do not retry it; choose a different approach.`;

export default function permissionsExtension(pi: ExtensionAPI) {
	pi.registerFlag("permission-mode", {
		description: "Permission mode: default | acceptEdits | plan | bypassPermissions",
		type: "string",
	});
	pi.registerFlag("dangerously-skip-permissions", {
		description: "Skip all permission prompts (Claude Code compatible)",
		type: "boolean",
	});

	/**
	 * Subagent children (pi subprocesses spawned by pi-subagents) inherit the
	 * parent session's permission mode, Claude Code-style: the parent exports
	 * it via env, the child's copy of this extension reads it back.
	 */
	const MODE_ENV = "CC_PERMISSION_MODE";
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";

	let mode: PermissionMode = "default";
	let deny: PermissionRule[] = [];
	let ask: PermissionRule[] = [];
	let allow: PermissionRule[] = [];
	const sessionAllows: PermissionRule[] = [];

	const setMode = (next: PermissionMode) => {
		mode = next;
		process.env[MODE_ENV] = next;
		if (mode === "plan") {
			pi.events.emit(REMINDER_CHANNEL, {
				text: "Plan mode is active. You may only inspect the codebase with read-only tools. Do NOT make any edits or run state-changing commands; research and present a plan to the user instead.",
				scope: "every-turn",
				key: "permission-mode",
			});
		} else {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `The user's permission mode is now "${mode}".`,
			});
			pi.events.emit(REMINDER_CHANNEL, { remove: true, key: "permission-mode" });
		}
	};

	const reloadSettings = (ctx: ExtensionContext) => {
		const settings = loadPermissionSettings(ctx.cwd, os.homedir());
		deny = parseRules(settings.deny);
		ask = parseRules(settings.ask);
		allow = parseRules(settings.allow);

		const flagMode = pi.getFlag("permission-mode");
		const inheritedMode = isSubagentChild ? process.env[MODE_ENV] : undefined;
		if (pi.getFlag("dangerously-skip-permissions") === true) {
			mode = "bypassPermissions";
		} else if (isPermissionMode(flagMode)) {
			mode = flagMode;
		} else if (isPermissionMode(inheritedMode)) {
			mode = inheritedMode;
		} else if (settings.defaultMode) {
			mode = settings.defaultMode;
		}
		if (mode === "plan") setMode("plan");
		process.env[MODE_ENV] = mode;
	};

	pi.on("session_start", (_event, ctx) => {
		reloadSettings(ctx);
	});

	// Mode-change requests from other extensions (e.g. plan-mode tools).
	pi.events.on("pincer:set-permission-mode", (data) => {
		const requested = (data as { mode?: unknown })?.mode;
		if (isPermissionMode(requested)) setMode(requested);
	});

	pi.on("tool_call", async (event, ctx) => {
		const subject = extractSubject(normalizeToolName(event.toolName), event.input as Record<string, unknown>);
		const result = decide({
			toolName: event.toolName,
			subject,
			cwd: ctx.cwd,
			mode,
			deny,
			ask,
			allow: [...allow, ...sessionAllows],
		});

		if (result.decision === "allow") return undefined;

		if (result.decision === "deny") {
			if (result.cause === "plan-mode") return { block: true, reason: DENIED_PLAN_MODE };
			return { block: true, reason: DENIED_BY_RULE(result.rule?.raw ?? "deny") };
		}

		// ask
		if (!ctx.hasUI) {
			return { block: true, reason: DENIED_NON_INTERACTIVE };
		}

		const preview = subject.length > 200 ? `${subject.slice(0, 200)}…` : subject;
		const title = `Allow ${event.toolName}?\n\n  ${preview || "(no arguments)"}`;
		const YES = "Yes";
		const YES_SESSION = "Yes, don't ask again this session";
		const NO = "No, tell the agent what to do differently";
		const choice = await ctx.ui.select(title, [YES, YES_SESSION, NO]);

		if (choice === YES) return undefined;
		if (choice === YES_SESSION) {
			const tool = normalizeToolName(event.toolName);
			const rule = tool === "bash" && subject ? parseRule(`bash(${subject})`) : parseRule(tool);
			if (rule) sessionAllows.push(rule);
			return undefined;
		}

		// The "tell the agent what to do differently" option has to actually carry
		// the user's words, or the model is left guessing why it was stopped.
		const feedback = await ctx.ui.input("What should the agent do instead?", "Optional — press Esc to skip");
		return {
			block: true,
			reason: feedback?.trim() ? `${DENIED_BY_USER}\n\nThe user said: ${feedback.trim()}` : DENIED_BY_USER,
		};
	});

	pi.registerCommand("permission-mode", {
		description: "Set permission mode: /permission-mode default|acceptEdits|plan|bypassPermissions",
		getArgumentCompletions: () =>
			["default", "acceptEdits", "plan", "bypassPermissions"].map((m) => ({ value: m, label: m })),
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!isPermissionMode(requested)) {
				ctx.ui.notify(`Unknown mode "${requested}". Modes: default, acceptEdits, plan, bypassPermissions`, "warning");
				return;
			}
			setMode(requested);
			ctx.ui.notify(`Permission mode: ${requested}`, "info");
		},
	});

	pi.registerCommand("permissions", {
		description: "Show permission mode and loaded rules",
		handler: async (_args, ctx) => {
			const fmt = (rules: PermissionRule[]) => (rules.length ? rules.map((r) => r.raw).join(", ") : "(none)");
			ctx.ui.notify(
				[
					`mode: ${mode}`,
					`deny: ${fmt(deny)}`,
					`ask: ${fmt(ask)}`,
					`allow: ${fmt(allow)}`,
					`session allows: ${fmt(sessionAllows)}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("allow", {
		description: 'Persist an allow rule: /allow Bash(npm test:*) [global]',
		handler: async (args, ctx) => {
			const global = /\s+global$/.test(args.trim());
			const raw = args.trim().replace(/\s+global$/, "");
			const rule = parseRule(raw);
			if (!rule) {
				ctx.ui.notify(`Could not parse rule: "${raw}". Format: Tool or Tool(pattern)`, "warning");
				return;
			}
			const paths = settingsPaths(ctx.cwd, os.homedir());
			const target = global ? paths.user : paths.local;
			persistAllowRule(raw, target);
			allow.push(rule);
			ctx.ui.notify(`Added allow rule ${raw} to ${target}`, "info");
		},
	});
}
