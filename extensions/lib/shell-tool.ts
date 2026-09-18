/**
 * The shared body of One Code's two shell tools (`bash`, `powershell`):
 * Claude Code's `run_in_background` on top of pi's own shell tool
 * definitions. Each extension supplies what differs — the tool's names and
 * texts, pi's base definition, its per-cwd foreground executor, its
 * pre-execution guard, and the spawn spec for a background run — and this
 * module owns the orchestration: guard → millisecond timeout clamp →
 * foreground delegate, or the background branch (blocking in one-shot modes,
 * detached on the shared background registry with a completion notification
 * otherwise). See extensions/bash/index.ts for why each piece is shaped as
 * it is; extensions/powershell/index.ts is the second consumer.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TObject } from "typebox";
import { generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import { type BashFinishSummary, runBackgroundBashBlocking, startBackgroundBash, tailCap } from "../bash/background.ts";
import { createTaskNotifier, oneShotNote, sessionOutlivesTurn, systemNotification } from "./notifications.ts";
import { commandToEvaluate, trackOriginalCommands } from "./original-command.ts";
import { persistIfLarge, sessionResultsDir } from "./persisted-output.ts";
import type { ShellSpawn } from "./shell-spawn.ts";
import { ccWrapBuiltinRenderers, linesComponent, resultLines } from "./tui-render.ts";

// The completion notification carries status + exit code + where the output is,
// plus only a short tail: a finished build used to push 30 KB (~8k tokens) into
// context unasked (review T7). The full tail stays behind task_output / the log.
export const NOTIFY_OUTPUT_CAP = 2_000;
/** One-shot modes return the whole output in the result; past this it is persisted (file + preview), never cut. */
export const ONE_SHOT_OUTPUT_CAP = 30_000;
/** Claude Code's cap; the tools' `timeout` is milliseconds, as CC's is. */
export const MAX_TIMEOUT_MS = 600_000;

/** The parameter shape both shell tools share (descriptions differ per tool). */
export interface ShellToolParams {
	command: string;
	timeout?: number;
	description?: string;
	run_in_background?: boolean;
}

/** The parts of pi's shell tool definition the shared body reads (structural, so the concrete generic types assign). */
export interface ShellToolBase {
	label: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	executionMode?: ToolDefinition["executionMode"];
	renderCall?: (args: any, theme: any, context: any) => any;
	renderResult?: (result: any, options: any, theme: any, context: any) => any;
}

/** pi's shell tool executor: `execute(toolCallId, { command, timeout: seconds }, signal, onUpdate, ctx)`. */
export interface ShellToolExecutor {
	execute: (toolCallId: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) => Promise<any>;
}

/** What one shell tool's definition supplies; everything else is shared. */
export interface ShellToolSpec<P extends TObject> {
	/** pi tool name (`bash`, `powershell`). */
	name: string;
	/** Claude Code's label for the `● Label(cmd)` transcript line and the notifications. */
	ccLabel: string;
	description: string;
	parameters: P;
	/** pi's base definition: label, snippet, guidelines, execution mode, renderers. */
	base: ShellToolBase;
	promptGuidelines?: readonly string[];
	/** The per-cwd foreground executor (pi's definition takes seconds). */
	foreground: (cwd: string) => ShellToolExecutor;
	/** Pre-execution guard on the model's ORIGINAL command; a string refuses the call. */
	guard: (command: string, opts: { background: boolean }) => string | undefined;
	/** The spawn for a background run, or undefined when the shell is unavailable. */
	backgroundShell: () => ShellSpawn | undefined;
	/** Rewrites the command for a background spawn (PowerShell prepends its UTF-8 prefix). Default: identity. */
	wrapBackgroundCommand?: (command: string) => string;
}

export function finishLine(summary: BashFinishSummary, timeoutSeconds?: number): string {
	if (summary.stopped) return "stopped";
	if (summary.timedOut) return `failed (timed out after ${timeoutSeconds}s)`;
	if (summary.exitCode === 0) return "completed";
	return `failed (${summary.exitCode !== null ? `exit code ${summary.exitCode}` : `terminated by ${summary.signal ?? "unknown signal"}`})`;
}

/** `<sessionDir>/bash/<taskId>/output.log` — one spool location for every shell tool (the shell panel reads it). */
export function taskLogPath(ctx: ExtensionContext, taskId: string): string | undefined {
	try {
		const dir = join(ctx.sessionManager.getSessionDir(), "bash", taskId);
		mkdirSync(dir, { recursive: true });
		return join(dir, "output.log");
	} catch {
		return undefined;
	}
}

export function registerShellTool<P extends TObject>(pi: ExtensionAPI, spec: ShellToolSpec<P>): void {
	const notifyTask = createTaskNotifier(pi);
	// A worktree session cd-wraps input.command; the pre-wrapper original arrives
	// over the bus keyed by toolCallId (never read from params — model-writable).
	const originalCommands = trackOriginalCommands(pi);
	const notify = (text: string, details: Record<string, unknown>) => notifyTask("task-notification", text, details);
	const wrap = spec.wrapBackgroundCommand ?? ((command: string) => command);

	// `● Label(cmd)` / elbow-indented output, like every other One Code tool.
	// Not passing base.renderCall also drops its timer state, so the misleading
	// "Took Ns" that counted permission-prompt wait disappears.
	const wrapped = ccWrapBuiltinRenderers<{ command?: string }>(spec.ccLabel, spec.base, { title: (a) => a?.command });

	pi.registerTool({
		name: spec.name,
		label: spec.base.label,
		description: spec.description,
		promptSnippet: spec.base.promptSnippet,
		promptGuidelines: spec.promptGuidelines ?? spec.base.promptGuidelines,
		executionMode: spec.base.executionMode,
		renderShell: wrapped.renderShell,
		renderCall: wrapped.renderCall as ToolDefinition<P>["renderCall"],
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
		}) as ToolDefinition<P>["renderResult"],
		parameters: spec.parameters,
		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as Static<P> & ShellToolParams;
			// Guards check the model's original command — a worktree session rewrites
			// input.command to `cd '<wt>' && (…)`, which would hide the real lead.
			const originalCommand = commandToEvaluate(originalCommands, toolCallId, params.command);
			const guardReason = spec.guard(originalCommand, { background: params.run_in_background === true });
			if (guardReason) return { content: [{ type: "text" as const, text: guardReason }], isError: true, details: {} };
			// pi's executor takes seconds; the model-facing unit is milliseconds
			// (Claude Code's), so a habitual `timeout: 120000` is 2 minutes, not
			// 33 hours (review T11).
			const timeoutSeconds =
				params.timeout !== undefined && Number.isFinite(params.timeout) && params.timeout > 0
					? Math.min(params.timeout, MAX_TIMEOUT_MS) / 1000
					: undefined;

			if (!params.run_in_background) {
				return spec.foreground(ctx.cwd).execute(toolCallId, { command: params.command, timeout: timeoutSeconds }, signal, onUpdate, ctx);
			}

			const shell = spec.backgroundShell();
			if (!shell) {
				return {
					content: [{ type: "text" as const, text: `No ${spec.ccLabel} executable is available for a background run.` }],
					isError: true,
					details: {},
				};
			}
			const id = generateTaskId();
			const logPath = taskLogPath(ctx, id);
			const description = params.description || params.command.slice(0, 80);
			const command = wrap(params.command);

			// One-shot modes (`-p` / `--mode json`) exit when the turn settles: a
			// detached task would be orphaned, and its completion callback would
			// call sendMessage on the disposed session and crash pi (measured,
			// STEERING-REVIEW-2026-09-05 H3). Run blocking there — the same rule the
			// Agent tool applies — and return the output in the result.
			if (!sessionOutlivesTurn(ctx.mode)) {
				const summary = await runBackgroundBashBlocking({ id, command, description, cwd: ctx.cwd, timeoutSeconds, logPath, shell }, signal);
				const output = persistIfLarge(summary.output, { dir: sessionResultsDir(ctx), id: `${spec.name}-${id}`, maxBytes: ONE_SHOT_OUTPUT_CAP });
				return {
					content: [
						{
							type: "text" as const,
							text: `${spec.ccLabel} task ${id} (${description}) ${finishLine(summary, timeoutSeconds)}. ${oneShotNote("command")}${logPath ? ` Log: ${logPath}.` : ""}\n\n${output}`,
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
							`Background ${spec.ccLabel} ${id} (${description}) ${finishLine(summary, timeoutSeconds)}. ${where}${tail ? `\n\nLast output:\n${tail}` : ""}`,
						),
						{ taskId: id, status: finishedTask.status, exitCode: summary.exitCode, logPath },
					);
				},
			});
			// The shell panel lists the task by the model's command, not a wrapped one.
			task.command = params.command;
			pi.events.emit(TASK_REGISTER_CHANNEL, task);

			return {
				content: [
					{
						type: "text" as const,
						text: `⏳ ${spec.ccLabel} task ${id} running in background (${description}).\n\nCompletion (with output) will arrive as a system notification on its own — you do not need to wait for it or poll; keep working.${logPath ? ` To check interim output, read ${logPath}.` : ""} If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.`,
					},
				],
				details: { taskId: id, logPath },
			};
		},
	} as ToolDefinition<P>);
}
