/**
 * bash extension — Claude Code's Bash `run_in_background` on top of pi's own
 * bash tool.
 *
 * Registering a tool named `bash` overrides the built-in (findings §2), which
 * is how pi's official sandbox example does it too. The foreground path
 * delegates to pi's real executor (`createBashToolDefinition`) so upstream
 * bash behavior — timeout handling, truncation, PI_* env, spawn hooks — stays
 * exactly pi's; this file only adds the background branch.
 *
 * A background run spawns detached, returns a task id immediately, spools
 * output to `<sessionDir>/bash/<taskId>/output.log`, registers on the shared
 * background registry (task_output/task_stop just work — they are
 * kind-agnostic), and announces completion as a steered system notification
 * (lib/notifications.ts). The permission gate and auto-mode classifier run before
 * execute like any bash call — a background command is NOT auto-allowed, and
 * the gate fires before anything detaches.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import { type BashFinishSummary, runBackgroundBashBlocking, startBackgroundBash, tailCap } from "./background.ts";
import { bashGuardReason } from "./guards.ts";
import { commandToEvaluate, trackOriginalCommands } from "../lib/original-command.ts";
import { createTaskNotifier, oneShotNote, sessionOutlivesTurn, systemNotification } from "../lib/notifications.ts";
import { persistIfLarge, sessionResultsDir } from "../lib/persisted-output.ts";
import { perCwd } from "../lib/per-cwd.ts";
import { readSettingsEnv } from "../lib/claude-settings.ts";
import { bashSpawn } from "../lib/shell-spawn.ts";
import { ccWrapBuiltinRenderers, linesComponent, resultLines } from "../lib/tui-render.ts";
import { homedir } from "node:os";

// The completion notification carries status + exit code + where the output is,
// plus only a short tail: a finished build used to push 30 KB (~8k tokens) into
// context unasked (review T7). The full tail stays behind task_output / the log.
const NOTIFY_OUTPUT_CAP = 2_000;
/** One-shot modes return the whole output in the result; past this it is persisted (file + preview), never cut. */
const ONE_SHOT_OUTPUT_CAP = 30_000;
/** Claude Code's Bash cap; the tool's `timeout` is milliseconds, as CC's is. */
const MAX_TIMEOUT_MS = 600_000;

const BashParams = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds (max 600000)" })),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run detached and return a task id immediately instead of waiting. Completion arrives as a system notification; inspect with task_output, stop with task_stop. Use this instead of nohup/'&' — those leave an unmanaged orphan process",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "5-10 word description of what the command does (shown in notifications)" }),
	),
});

export default function bashExtension(pi: ExtensionAPI) {
	// Resolve the process's bash once, honouring CLAUDE_CODE_GIT_BASH_PATH from
	// the environment or Claude Code's user settings `env` block
	// (lib/shell-spawn.ts): every later spawn — background bash, monitor,
	// hooks — reads this cached resolution. An ignored override is reported
	// once, at the first session start.
	const bash = bashSpawn({ settingsEnv: readSettingsEnv(homedir()) });
	const shellPath = bash.spawn?.commandTransport === "stdin" ? undefined : bash.spawn?.shell;
	// pi's definition supplies the description and TUI renderers; the executor
	// is re-created per working directory because it closes over cwd (worktree
	// switches change ctx.cwd mid-session). The same bash drives pi's foreground
	// executor, so the override applies there too.
	const base = createBashToolDefinition(process.cwd(), { shellPath });
	const foreground = perCwd((cwd: string) => createBashToolDefinition(cwd, { shellPath }));
	let warned = false;
	pi.on("session_start", (_event, ctx) => {
		if (warned || !bash.warning) return;
		warned = true;
		if (ctx.hasUI) ctx.ui.notify(bash.warning, "warning");
		else process.stderr.write(`${bash.warning}\n`);
	});
	// pi's base sentence is "Optionally provide a timeout in seconds." — but the
	// `timeout` parameter and the execute path both use milliseconds (Claude
	// Code's Bash unit; the executor divides by 1000). The two must not
	// contradict, or a model that trusts the description sends `timeout: 120`
	// and gets a 120 ms deadline (TOOL-FIDELITY-REVIEW-2026-09-07 H3). Swap in
	// CC's Bash sentence.
	const baseDescription = base.description.replace(
		"Optionally provide a timeout in seconds.",
		"`timeout` is in milliseconds: default 120000, max 600000.",
	);

	const notifyTask = createTaskNotifier(pi);
	// A worktree session cd-wraps input.command; the pre-wrapper original arrives
	// over the bus keyed by toolCallId (never read from params — model-writable).
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

	pi.registerTool({
		name: "bash",
		label: base.label,
		description: `${baseDescription} Pass run_in_background: true for long-running commands (builds, servers, watches): it returns a task id immediately so you can keep working, completion arrives as a system notification, and the output is retrievable with task_output / stoppable with task_stop (both deferred — load them with tool_search; in a one-shot print/json session the call runs to completion and returns the output directly). Foreground \`sleep\` is blocked; to wait on a condition use the monitor tool (deferred — load it with tool_search select:monitor) with an until-loop.`,
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		executionMode: base.executionMode,
		...(() => {
			// `● Bash(cmd)` / elbow-indented output, like every other One Code tool.
			// Not passing base.renderCall also drops its timer state, so the
			// misleading "Took Ns" that counted permission-prompt wait disappears.
			const wrapped = ccWrapBuiltinRenderers<{ command?: string }>("Bash", base, { title: (a) => a?.command });
			return {
				renderShell: wrapped.renderShell,
				renderCall: wrapped.renderCall as ToolDefinition<typeof BashParams>["renderCall"],
				renderResult: ((result, options, theme, context) => {
					// A background start returns a model-facing instruction paragraph;
					// the transcript needs one line (Claude Code: "Running in the background").
					const details = result.details as { taskId?: string; logPath?: string } | undefined;
					if (details?.taskId && !context.isError) {
						const line = options.expanded
							? `Running in the background (task ${details.taskId}${details.logPath ? ` · log: ${details.logPath}` : ""})`
							: "Running in the background (↓ to manage)";
						return linesComponent(() => resultLines(theme as any, line, options.expanded, false));
					}
					return wrapped.renderResult(result, options, theme, context);
				}) as ToolDefinition<typeof BashParams>["renderResult"],
			};
		})(),
		parameters: BashParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Guards check the model's original command — a worktree session rewrites
			// input.command to `cd '<wt>' && (…)`, which would hide the real lead.
			const originalCommand = commandToEvaluate(originalCommands, toolCallId, params.command);
			const guardReason = bashGuardReason(originalCommand, { background: params.run_in_background === true });
			if (guardReason) return { content: [{ type: "text" as const, text: guardReason }], isError: true, details: {} };
			const timeoutSeconds =
				params.timeout !== undefined && Number.isFinite(params.timeout) && params.timeout > 0
					? Math.min(params.timeout, MAX_TIMEOUT_MS) / 1000
					: undefined;

			if (!params.run_in_background) {
				// pi's executor takes seconds; the model-facing unit is milliseconds
				// (Claude Code's Bash), so a habitual `timeout: 120000` is 2 minutes,
				// not 33 hours (review T11).
				return foreground(ctx.cwd).execute(
					toolCallId,
					{ command: params.command, timeout: timeoutSeconds },
					signal,
					onUpdate,
					ctx,
				);
			}

			const id = generateTaskId();
			const logPath = taskLogPath(ctx, id);
			const description = params.description || params.command.slice(0, 80);

			// One-shot modes (`-p` / `--mode json`) exit when the turn settles: a
			// detached task would be orphaned, and its completion callback would
			// call sendMessage on the disposed session and crash pi (measured,
			// STEERING-REVIEW-2026-09-05 H3). Run blocking there — the same rule the
			// Agent tool applies — and return the output in the result.
			if (!sessionOutlivesTurn(ctx.mode)) {
				const summary = await runBackgroundBashBlocking(
					{ id, command: params.command, description, cwd: ctx.cwd, timeoutSeconds, logPath },
					signal,
				);
				const output = persistIfLarge(summary.output, { dir: sessionResultsDir(ctx), id: `bash-${id}`, maxBytes: ONE_SHOT_OUTPUT_CAP });
				return {
					content: [
						{
							type: "text",
							text: `Bash task ${id} (${description}) ${finishLine(summary, timeoutSeconds)}. ${oneShotNote("command")}${logPath ? ` Log: ${logPath}.` : ""}\n\n${output}`,
						},
					],
					// No taskId: nothing was registered behind task_output/task_stop, and
					// its presence is what renderResult reads as "running in the background".
					details: { logPath },
					isError: summary.exitCode !== 0 && !summary.stopped,
				};
			}

			const task = startBackgroundBash({
				id,
				command: params.command,
				description,
				cwd: ctx.cwd,
				timeoutSeconds,
				logPath,
				onFinished: (finishedTask, summary) => {
					const tail = tailCap(summary.output, NOTIFY_OUTPUT_CAP).trim();
					const where = `Full output: task_output ${id}${logPath ? ` (or read ${logPath})` : ""}.`;
					notify(
						systemNotification(
							`Background bash ${id} (${description}) ${finishLine(summary, timeoutSeconds)}. ${where}${tail ? `\n\nLast output:\n${tail}` : ""}`,
						),
						{ taskId: id, status: finishedTask.status, exitCode: summary.exitCode, logPath },
					);
				},
			});
			pi.events.emit(TASK_REGISTER_CHANNEL, task);

			return {
				content: [
					{
						type: "text",
						text: `⏳ Bash task ${id} running in background (${description}).\n\nCompletion (with output) will arrive as a system notification on its own — you do not need to wait for it or poll; keep working.${logPath ? ` To check interim output, read ${logPath}.` : ""} If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.`,
					},
				],
				details: { taskId: id, logPath },
			};
		},
	});
}
