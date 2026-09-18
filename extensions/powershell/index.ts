/**
 * powershell extension — Claude Code's PowerShell tool on top of pi's own
 * `powershell` built-in (docs/decisions/windows.md, findings §22).
 *
 * Registering a tool named `powershell` overrides pi's built-in (findings §2),
 * exactly as `extensions/bash` overrides `bash`. The foreground path delegates
 * to pi's real definition (`createPowerShellToolDefinition`) so schema, cwd
 * handling, truncation and streaming stay upstream's — with One Code's own
 * `operations` (lib/shell-spawn.ts), because pi's local operations throw off
 * Windows and this tool is developed against a `pwsh` on this Mac. The
 * description is Claude Code's captured text (description.ts); the
 * `run_in_background` branch is the bash extension's spool/registry machinery
 * under a PowerShell spawn spec; the guards are the PowerShell spelling of
 * bash's.
 *
 * Activation follows Claude Code's gate (policy.ts): pi never activates a
 * registered override of a built-in name on its own, so `session_start` and
 * `model_select` reconcile the active list — `powershell` on when the policy
 * says so, `bash` off when no bash exists (Windows without Git for Windows).
 * Children get the same reconcile: `openChildSession` binds extensions, which
 * emits `session_start`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import { type BashFinishSummary, runBackgroundBashBlocking, startBackgroundBash, tailCap } from "../bash/background.ts";
import { commandToEvaluate, trackOriginalCommands } from "../lib/original-command.ts";
import { createTaskNotifier, oneShotNote, sessionOutlivesTurn, systemNotification } from "../lib/notifications.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { perCwd } from "../lib/per-cwd.ts";
import {
	bashSpawn,
	createPowerShellOperations,
	POWERSHELL_UTF8_PREFIX,
	powerShellEdition,
	powerShellSpawn,
	type ShellSpawn,
} from "../lib/shell-spawn.ts";
import { ccWrapBuiltinRenderers, linesComponent, resultLines } from "../lib/tui-render.ts";
import { powerShellToolDescription } from "./description.ts";
import { powershellGuardReason } from "./guards.ts";
import { shellToolPolicy, withShellTools } from "./policy.ts";

const NOTIFY_OUTPUT_CAP = 2_000;
const ONE_SHOT_OUTPUT_CAP = 30_000;
/** Claude Code's cap; the tool's `timeout` is milliseconds, as CC's is. */
const MAX_TIMEOUT_MS = 600_000;

/** Claude Code's PowerShell schema (captured), minus `dangerouslyDisableSandbox` — One Code has no sandbox to disable. */
const PowerShellParams = Type.Object({
	command: Type.String({ description: "The PowerShell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds (max 600000)" })),
	description: Type.Optional(Type.String({ description: "Clear, concise description of what this command does in active voice." })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run this command in the background." })),
});

export default function powershellExtension(pi: ExtensionAPI) {
	const spec = powerShellSpawn();
	const operations = createPowerShellOperations(() => spec);
	const base = createPowerShellToolDefinition(process.cwd(), { operations });
	const foreground = perCwd((cwd: string) => createPowerShellToolDefinition(cwd, { operations }));
	const policy = () =>
		shellToolPolicy({ platform: process.platform, env: process.env, bash: !!bashSpawn().spawn, powershell: spec !== undefined });
	const startupPolicy = policy();

	const notifyTask = createTaskNotifier(pi);
	const originalCommands = trackOriginalCommands(pi);
	const notify = (text: string, details: Record<string, unknown>) => notifyTask("task-notification", text, details);

	const taskLogPath = (ctx: ExtensionContext, taskId: string): string | undefined => {
		try {
			const dir = join(ctx.sessionManager.getSessionDir(), "bash", taskId);
			mkdirSync(dir, { recursive: true });
			return join(dir, "output.log");
		} catch {
			return undefined;
		}
	};

	const finishLine = (summary: BashFinishSummary, timeoutSeconds?: number): string => {
		if (summary.stopped) return "stopped";
		if (summary.timedOut) return `failed (timed out after ${timeoutSeconds}s)`;
		if (summary.exitCode === 0) return "completed";
		return `failed (${summary.exitCode !== null ? `exit code ${summary.exitCode}` : `terminated by ${summary.signal ?? "unknown signal"}`})`;
	};

	/** The background spawn: pi's flags plus the UTF-8 prefix the foreground path prepends. */
	const backgroundShell = (): ShellSpawn | undefined => spec;

	// The guideline joins the system prompt's tool guidelines at registration
	// (before the first request), so it is part of the cached prefix, never a
	// mid-session rebuild. Claude Code names PowerShell the primary shell when
	// the tool is on (2.1.126).
	const guidelines = [
		...(base.promptGuidelines ?? []),
		...(startupPolicy.primary === "powershell"
			? ["PowerShell is the primary shell on this machine: use the powershell tool for terminal operations (git, npm, build tools)"]
			: []),
	];

	pi.registerTool({
		name: "powershell",
		label: base.label,
		description: powerShellToolDescription(powerShellEdition(spec)),
		promptSnippet: base.promptSnippet,
		promptGuidelines: guidelines,
		executionMode: base.executionMode,
		...(() => {
			const wrapped = ccWrapBuiltinRenderers<{ command?: string }>("PowerShell", base, { title: (a) => a?.command });
			return {
				renderShell: wrapped.renderShell,
				renderCall: wrapped.renderCall as ToolDefinition<typeof PowerShellParams>["renderCall"],
				renderResult: ((result, options, theme, context) => {
					const details = result.details as { taskId?: string; logPath?: string } | undefined;
					if (details?.taskId && !context.isError) {
						const line = options.expanded
							? `Running in the background (task ${details.taskId}${details.logPath ? ` · log: ${details.logPath}` : ""})`
							: "Running in the background (↓ to manage)";
						return linesComponent(() => resultLines(theme as any, line, options.expanded, false));
					}
					return wrapped.renderResult(result, options, theme, context);
				}) as ToolDefinition<typeof PowerShellParams>["renderResult"],
			};
		})(),
		parameters: PowerShellParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const originalCommand = commandToEvaluate(originalCommands, toolCallId, params.command);
			const guardReason = powershellGuardReason(originalCommand, { background: params.run_in_background === true });
			if (guardReason) return { content: [{ type: "text" as const, text: guardReason }], isError: true, details: {} };
			const timeoutSeconds =
				params.timeout !== undefined && Number.isFinite(params.timeout) && params.timeout > 0
					? Math.min(params.timeout, MAX_TIMEOUT_MS) / 1000
					: undefined;

			if (!params.run_in_background) {
				return foreground(ctx.cwd).execute(toolCallId, { command: params.command, timeout: timeoutSeconds }, signal, onUpdate, ctx);
			}

			const shell = backgroundShell();
			if (!shell) {
				return {
					content: [{ type: "text" as const, text: "No PowerShell executable is available for a background run." }],
					isError: true,
					details: {},
				};
			}
			const id = generateTaskId();
			const logPath = taskLogPath(ctx, id);
			const description = params.description || params.command.slice(0, 80);
			const command = `${POWERSHELL_UTF8_PREFIX}${params.command}`;

			if (!sessionOutlivesTurn(ctx.mode)) {
				const summary = await runBackgroundBashBlocking(
					{ id, command, description, cwd: ctx.cwd, timeoutSeconds, logPath, shell },
					signal,
				);
				const output = persistIfLarge(summary.output, { dir: sessionResultsDir(ctx), id: `powershell-${id}`, maxBytes: ONE_SHOT_OUTPUT_CAP });
				return {
					content: [
						{
							type: "text",
							text: `PowerShell task ${id} (${description}) ${finishLine(summary, timeoutSeconds)}. ${oneShotNote("command")}${logPath ? ` Log: ${logPath}.` : ""}\n\n${output}`,
						},
					],
					details: { logPath },
					isError: summary.exitCode !== 0 && !summary.stopped,
				};
			}

			const task = startBackgroundBash({
				id,
				command,
				description,
				cwd: ctx.cwd,
				timeoutSeconds,
				logPath,
				shell,
				onFinished: (finishedTask, summary) => {
					const tail = tailCap(summary.output, NOTIFY_OUTPUT_CAP).trim();
					const where = `Full output: task_output ${id}${logPath ? ` (or read ${logPath})` : ""}.`;
					notify(
						systemNotification(
							`Background PowerShell ${id} (${description}) ${finishLine(summary, timeoutSeconds)}. ${where}${tail ? `\n\nLast output:\n${tail}` : ""}`,
						),
						{ taskId: id, status: finishedTask.status, exitCode: summary.exitCode, logPath },
					);
				},
			});
			// The shell panel lists the task by the model's command, not the prefixed one.
			task.command = params.command;
			pi.events.emit(TASK_REGISTER_CHANNEL, task);

			return {
				content: [
					{
						type: "text",
						text: `⏳ PowerShell task ${id} running in background (${description}).\n\nCompletion (with output) will arrive as a system notification on its own — you do not need to wait for it or poll; keep working.${logPath ? ` To check interim output, read ${logPath}.` : ""} If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.`,
					},
				],
				details: { taskId: id, logPath },
			};
		},
	});

	let noticesShown = false;
	const reconcile = (ctx?: Pick<ExtensionContext, "hasUI" | "ui">) => {
		const current = policy();
		const active = pi.getActiveTools();
		const next = withShellTools(active, current);
		if (next.join(" ") !== active.join(" ")) pi.setActiveTools(next);
		if (noticesShown || current.notices.length === 0) return;
		noticesShown = true;
		for (const notice of current.notices) {
			if (ctx?.hasUI) ctx.ui.notify(notice, "warning");
			else process.stderr.write(`${notice}\n`);
		}
	};

	pi.on("session_start", (_event, ctx) => reconcile(ctx));
	pi.on("model_select", () => reconcile());
}
