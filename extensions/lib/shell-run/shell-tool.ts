/**
 * The shared body of One Code's two shell tools (`bash`, `powershell`):
 * Claude Code's `run_in_background` on top of pi's own shell tool
 * definitions. Each extension supplies what differs — the tool's names and
 * texts, pi's base definition, its per-cwd foreground executor, its
 * pre-execution guard, and the spawn spec for a background run — and this
 * module owns the orchestration: guard → millisecond timeout clamp →
 * foreground delegate, or the background branch (blocking in one-shot modes,
 * detached on the shared background registry with a completion notification
 * otherwise). See extensions/tools/bash/index.ts for why each piece is shaped as
 * it is; extensions/tools/powershell/index.ts is the second consumer.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, type TObject, type TProperties, Type } from "typebox";
import { generateTaskId, TASK_REGISTER_CHANNEL } from "../agents/task-registry.ts";
import { type BashFinishSummary, runBackgroundBashBlocking, startBackgroundBash, tailCap } from "./bash-background.ts";
import { createTaskNotifier, oneShotNote, sessionOutlivesTurn, shellSummary, TASK_COMPLETION_KEY, type TaskStatus, taskNotification } from "../notify/notifications.ts";
import { commandToEvaluate, trackOriginalCommands } from "../shell/original-command.ts";
import { persistedFilePreview, persistIfLarge, sessionResultsDir } from "../request/persisted-output.ts";
import { withClaudeCodeShellText } from "./shell-result.ts";
import type { ShellBlock, ShellEnd, ShellResultText, ShellSandboxText } from "./shell-text.ts";
import { sandboxConfigured, sandboxedCommand } from "./sandbox.ts";
import { COMMAND_HOST_MAX_LENGTH, COMMAND_HOSTS_MAX } from "./sandbox-settings.ts";
import { bashParserReady } from "../shell/bash-parser.ts";
import type { ShellSpawn } from "./shell-spawn.ts";
import { keepSpillReadable } from "./spill-file.ts";
import { ccWrapBuiltinRenderers, withResultDisplay } from "../ui/tui-render.ts";
import { shellBlockedLine } from "../ui/result-summary-shell.ts";
import { registerVariantTool } from "../profile/tool-variants.ts";
import { shellResultText } from "./shell-text.ts";

// The completion notification carries status + exit code + where the output is,
// plus only a short tail: a finished build used to push 30 KB (~8k tokens) into
// context unasked (review T7). The full tail stays behind task_output / the log.
export const NOTIFY_OUTPUT_CAP = 2_000;
/** Claude Code's inline cap for a shell's output; past it the output is persisted (file + head preview), never cut. */
export const INLINE_OUTPUT_CAP = 30_000;
/** Claude Code's cap; the tools' `timeout` is milliseconds, as CC's is. */
export const MAX_TIMEOUT_MS = 600_000;
/**
 * Claude Code's default for a command that names no `timeout`, which both
 * tool descriptions promise. pi's executor has no default, so without this a
 * foreground `npm run dev` ran until Esc, and forever in a `-p` run.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** The parameter shape both shell tools share (descriptions differ per tool). */
export interface ShellToolParams {
	command: string;
	timeout?: number;
	description?: string;
	run_in_background?: boolean;
	/** Only in a session whose settings turn the shell sandbox on. */
	dangerouslyDisableSandbox?: boolean;
	/** Only there too: hosts this one command needs, honoured in auto mode after the classifier read them. */
	allowed_domains?: string[];
}

/** The parts of pi's shell tool definition the shared body reads (structural, so the concrete generic types assign). */
export interface ShellToolBase {
	label: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	executionMode?: ToolDefinition["executionMode"];
	constrainedSampling?: ToolDefinition["constrainedSampling"];
	renderCall?: (args: any, theme: any, context: any) => any;
	renderResult?: (result: any, options: any, theme: any, context: any) => any;
}

/** pi's shell tool executor: `execute(toolCallId, { command, timeout: seconds }, signal, onUpdate, ctx)`. */
export interface ShellToolExecutor {
	execute: (toolCallId: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionToolContext) => Promise<any>;
}

/**
 * The parameters the shell sandbox adds to a tool that runs commands, where
 * the settings turn it on (and none otherwise): the host list a command names
 * for itself, and with `leave` the request to run outside the sandbox. Both
 * stay in the schema when the settings forbid leaving the sandbox, as in
 * Claude Code: the section tells the model the request is off.
 */
export function sandboxParams(text: Pick<ShellSandboxText, "disableParam" | "allowedDomainsParam">, opts: { leave: boolean }): TProperties {
	if (!sandboxConfigured()) return {};
	const allowed_domains = Type.Optional(Type.Array(Type.String({ maxLength: COMMAND_HOST_MAX_LENGTH }), { description: text.allowedDomainsParam, maxItems: COMMAND_HOSTS_MAX }));
	return opts.leave ? { dangerouslyDisableSandbox: Type.Optional(Type.Boolean({ description: text.disableParam })), allowed_domains } : { allowed_domains };
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
	/** Pre-execution guard on the model's ORIGINAL command; a block refuses the call, worded with this session's `words`. */
	guard: (command: string, opts: { background: boolean }) => ShellBlock | undefined;
	/** The result and refusal words: a child session's are built for its own tools. Default: the main session's. */
	words?: () => ShellResultText;
	/** The spawn for a background run, or undefined when the shell is unavailable. */
	backgroundShell: () => ShellSpawn | undefined;
	/** The sandbox's words, for a call it refuses. */
	sandboxText: () => ShellSandboxText;
	/**
	 * For a tool whose own shell is not bash: how its command runs inside the
	 * sandbox, which runs everything through a bash. `bash` is that bash,
	 * `line` the bash line that runs the command in the tool's shell, and
	 * `foreground` runs such a line with the tool's own result shape. Without
	 * it the tool's own shell (`backgroundShell`) is the sandbox's bash.
	 */
	sandboxed?: { bash(): ShellSpawn | undefined; line(command: string): string; foreground(cwd: string): ShellToolExecutor };
	/** Rewrites the command for a background spawn (PowerShell prepends its UTF-8 prefix). Default: identity. */
	wrapBackgroundCommand?: (command: string) => string;
}

/**
 * How a shell task ended, read once from the finish summary: CC's `<status>`
 * (a stop is `killed`, a timeout or non-zero exit `failed`) and, for a failure
 * that an exit code does not explain, the detail (the timeout, the signal).
 * The one-shot result and the background notification both build
 * on this, so the two can never disagree; the profile words it.
 */
export function shellEnd(summary: BashFinishSummary, timeoutSeconds?: number): ShellEnd {
	if (summary.stopped) return { kind: "stopped" };
	if (summary.timedOut) return { kind: "timedOut", seconds: timeoutSeconds };
	if (summary.exitCode === 0) return { kind: "completed" };
	return summary.exitCode === null ? { kind: "signal", ...(summary.signal ? { signal: summary.signal } : {}) } : { kind: "exitCode", code: summary.exitCode };
}

export function shellFinish(summary: BashFinishSummary, timeoutSeconds?: number): { status: TaskStatus; detail?: string } {
	const end = shellEnd(summary, timeoutSeconds);
	if (end.kind === "stopped") return { status: "killed" };
	if (end.kind === "completed") return { status: "completed" };
	return { status: "failed", detail: shellResultText().failureDetail(end) };
}

/** `<sessionDir>/bash/<taskId>/output.log` — one spool location for every shell tool (the shell panel reads it). */
export function taskLogPath(ctx: ExtensionContext, taskId: string): string | undefined {
	try {
		const dir = join(sessionResultsDir(ctx), "bash", taskId);
		mkdirSync(dir, { recursive: true });
		return join(dir, "output.log");
	} catch {
		return undefined;
	}
}

/**
 * Register the shell tool; the returned setter registers it again with a new
 * description (a no-op when the text is unchanged), for a description that
 * follows the session (lib/profile/tool-variants.ts). Everything else — the notifier,
 * the original-command tracker, execute — is built once.
 */
export function registerShellTool<P extends TObject>(pi: ExtensionAPI, spec: ShellToolSpec<P>): (description: string) => void {
	const words = spec.words ?? shellResultText;
	// A completion whose output task_output just returned is withdrawn (CC's
	// delivered_as_tool_result) — the model already has it.
	const notifyTask = createTaskNotifier(pi, { withdrawOnDelivery: true });
	// A worktree session cd-wraps input.command; the pre-wrapper original arrives
	// over the bus keyed by toolCallId (never read from params — model-writable).
	const originalCommands = trackOriginalCommands(pi);
	const notify = (text: string, details: Record<string, unknown>) => notifyTask("task-notification", text, details);
	const wrap = spec.wrapBackgroundCommand ?? ((command: string) => command);

	// `● Label(cmd)` / elbow-indented output, like every other One Code tool.
	// Not passing base.renderCall also drops its timer state, so the misleading
	// "Took Ns" that counted permission-prompt wait disappears.
	// A background start returns a model-facing instruction paragraph; the
	// transcript needs one line (Claude Code: "Running in the background").
	// A guard's refusal is a paragraph to the model; the user sees what tripped it (details.blocked).
	const errorLine = (result: { details?: unknown }) => {
		const text = shellBlockedLine(result.details);
		return text === undefined ? undefined : { text, color: "error" as const };
	};
	const wrapped = withResultDisplay(ccWrapBuiltinRenderers<{ command?: string }>(spec.ccLabel, spec.base, { title: (a) => a?.command, errorLine }), (result, expanded) => {
		const details = result.details as { taskId?: string; logPath?: string } | undefined;
		if (!details?.taskId) return undefined;
		return expanded ? `Running in the background (task ${details.taskId}${details.logPath ? ` · log: ${details.logPath}` : ""})` : "Running in the background (↓ to manage)";
	});

	const definition = {
		name: spec.name,
		label: spec.base.label,
		description: spec.description,
		promptSnippet: spec.base.promptSnippet,
		promptGuidelines: spec.promptGuidelines ?? spec.base.promptGuidelines,
		executionMode: spec.base.executionMode,
		// pi 0.86 samples its own shell tools against a strict JSON schema by
		// default (`{ type: "json_schema", strict: "prefer" }`); inherit that as
		// tool-style does for read/edit/write, so every built-in-shaped tool gets
		// the same treatment. Our parameter objects are strict-compatible, pi
		// strips the `null` a strict optional arrives as before validation, and
		// a provider without strict tools is left alone by "prefer".
		constrainedSampling: spec.base.constrainedSampling,
		renderShell: wrapped.renderShell,
		renderCall: wrapped.renderCall as ToolDefinition<P>["renderCall"],
		renderResult: wrapped.renderResult as ToolDefinition<P>["renderResult"],
		parameters: spec.parameters,
		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as Static<P> & ShellToolParams;
			// Guards check the model's original command — a worktree session rewrites
			// input.command to `cd '<wt>' && (…)`, which would hide the real lead.
			const originalCommand = commandToEvaluate(originalCommands, toolCallId, params.command);
			const block = spec.guard(originalCommand, { background: params.run_in_background === true });
			// `blocked` names the guard for the transcript's short line; details never reach the model.
			if (block) return { content: [{ type: "text" as const, text: words().blocked(block) }], isError: true, details: { blocked: block.kind } };
			// pi's executor takes seconds; the model-facing unit is milliseconds
			// (Claude Code's), so a habitual `timeout: 120000` is 2 minutes, not
			// 33 hours (review T11). A command that names none gets Claude Code's
			// default, which is what the descriptions promise.
			// The session's sandbox wraps what runs; guards, rules and the transcript keep the model's command.
			const sandboxed = await sandboxedCommand({
				command: params.command,
				original: originalCommand,
				disable: params.dangerouslyDisableSandbox === true,
				// A worktree session's command runs in the worktree, which is published with its original; pi's own cwd stays the checkout's.
				cwd: originalCommands.get(toolCallId)?.cwd ?? ctx.cwd,
				bash: (spec.sandboxed?.bash ?? spec.backgroundShell)()?.shell,
				...(spec.sandboxed ? { line: () => spec.sandboxed!.line(params.command) } : {}),
				id: toolCallId,
			});
			if ("refused" in sandboxed) return { content: [{ type: "text" as const, text: spec.sandboxText().refused(sandboxed.refused) }], isError: true, details: {} };
			// A wrapped command of a tool whose shell is not bash is a bash line: bash runs it.
			const viaBash = sandboxed.run ? spec.sandboxed : undefined;
			const explicitTimeout = params.timeout !== undefined && Number.isFinite(params.timeout) && params.timeout > 0;
			const timeoutSeconds = (explicitTimeout ? Math.min(params.timeout!, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS) / 1000;

			if (!params.run_in_background) {
				// pi spills a long output to os.tmpdir(), outside every readable root;
				// move it where the model's read of it is a working-space read, and
				// cut the output Claude Code's way (its head, not pi's tail). Then
				// Claude Code's result text (`Exit code N` first, trimmed output).
				const result = await keepSpillReadable(
					() => (viaBash ? viaBash.foreground(ctx.cwd) : spec.foreground(ctx.cwd)).execute(toolCallId, { command: sandboxed.command, timeout: timeoutSeconds }, signal, onUpdate, ctx),
					sessionResultsDir(ctx),
					{ inlineMax: INLINE_OUTPUT_CAP, id: `${spec.name}-${toolCallId}` },
				)
					.catch((error: unknown) => {
						// A command that timed out or was stopped still says what the sandbox denied it (a host retried until the deadline).
						if (sandboxed.run && error instanceof Error) error.message = sandboxed.run.withViolations(error.message);
						throw error;
					})
					.finally(() => sandboxed.run?.finish());
				// The no-match check parses the command; only bash results need the grammar.
				if (spec.name === "bash") await bashParserReady();
				const shaped = withClaudeCodeShellText(result, spec.name, originalCommand);
				// What the sandbox denied (a host its proxy refused) follows the output.
				const first = shaped.content?.[0];
				if (!sandboxed.run || first?.type !== "text" || typeof first.text !== "string") return shaped;
				return { ...shaped, content: [{ ...first, text: sandboxed.run.withViolations(first.text) }, ...shaped.content.slice(1)] };
			}

			// A wrapped command has its bash already (`sandboxedCommand` refuses without one), so nothing is held here.
			const shell = viaBash ? viaBash.bash() : spec.backgroundShell();
			if (!shell) {
				return {
					content: [{ type: "text" as const, text: words().noBackgroundShell({ label: spec.ccLabel }) }],
					isError: true,
					details: {},
				};
			}
			const id = generateTaskId();
			const logPath = taskLogPath(ctx, id);
			const description = params.description || params.command.slice(0, 80);
			const command = viaBash ? sandboxed.command : wrap(sandboxed.command);

			// One-shot modes (`-p` / `--mode json`) exit when the turn settles: a
			// detached task would be orphaned, and its completion callback would
			// call sendMessage on the disposed session and crash pi (measured,
			// STEERING-REVIEW-2026-09-05 H3). Run blocking there — the same rule the
			// Agent tool applies — and return the output in the result. The call
			// holds the turn like a foreground command, so it gets the foreground
			// deadline (the model's `timeout`, else the default): with none, a
			// server started this way hung the run forever. A detached shell below
			// keeps having no deadline (findings §31).
			if (!sessionOutlivesTurn(ctx.mode)) {
				const summary = await runBackgroundBashBlocking({ id, command, description, cwd: ctx.cwd, timeoutSeconds, logPath, shell, text: words() }, signal).finally(() => sandboxed.run?.finish());
				const spool = summary.logPath && Buffer.byteLength(summary.output, "utf8") > INLINE_OUTPUT_CAP
					? persistedFilePreview(summary.logPath)
					: undefined;
				const shown = spool ?? persistIfLarge(summary.output, { dir: sessionResultsDir(ctx), id: `${spec.name}-${id}`, maxBytes: INLINE_OUTPUT_CAP });
				const output = sandboxed.run ? sandboxed.run.withViolations(shown) : shown;
				return {
					content: [
						{
							type: "text" as const,
							text: words().ranToEnd({
								label: spec.ccLabel,
								id,
								description,
								end: shellEnd(summary, timeoutSeconds),
								note: oneShotNote("command"),
								...(summary.timedOut ? { deadline: { timeoutMs: timeoutSeconds * 1000, explicit: explicitTimeout, maxTimeoutMs: MAX_TIMEOUT_MS } } : {}),
								...(summary.logPath ? { logPath: summary.logPath } : {}),
								output,
							}),
						},
					],
					// No taskId: nothing was registered behind task_output/task_stop, and
					// its presence is what renderResult reads as "running in the background".
					details: { logPath: summary.logPath },
					isError: shellFinish(summary, timeoutSeconds).status === "failed",
				};
			}

			// No timeout here: Claude Code clears a command's timeout the
			// moment it goes to the background, so a detached shell has no
			// deadline (findings §31). Models habitually send `timeout: 600000`
			// next to `run_in_background`, which used to kill a dev server at
			// exactly 10 minutes. The one-shot path above keeps the timeout
			// because there the command holds the turn.
			const task = startBackgroundBash({
				text: words(),
				id,
				command,
				description,
				cwd: ctx.cwd,
				logPath,
				shell,
				onFinished: (finishedTask, summary) => {
					// The command's own host list ends with the command.
					sandboxed.run?.finish();
					// Claude Code's shell completion names the output file and nothing
					// else — the model reads it (or task_output) when it needs the text.
					// Without a spool file the tail rides `<result>` so nothing is lost.
					const { status, detail } = shellFinish(summary);
					// What the sandbox denied the command rides its completion: the log holds only the command's own words.
					const denied = sandboxed.run?.withViolations("").trim() ?? "";
					const tail = finishedTask.logPath ? "" : tailCap(summary.output, NOTIFY_OUTPUT_CAP, words().earlierTruncated).trim();
					notify(
						taskNotification({
							kind: "shell",
							taskId: id,
							toolUseId: toolCallId,
							outputFile: finishedTask.logPath,
							status,
							summary: shellSummary(description, status, summary.exitCode, detail),
							result: [tail, denied].filter(Boolean).join("\n") || undefined,
						}),
						{ taskId: id, status: finishedTask.status, exitCode: summary.exitCode, logPath: finishedTask.logPath, [TASK_COMPLETION_KEY]: true },
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
						text: words().backgroundStarted({ id, ...(logPath ? { logPath } : {}) }),
					},
				],
				details: { taskId: id, logPath },
			};
		},
	} as ToolDefinition<P>;
	return registerVariantTool(pi, spec.description, (description) => ({ ...definition, description }) as unknown as ToolDefinition);
}
