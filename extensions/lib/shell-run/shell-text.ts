/**
 * The shell tools' words (bash and powershell, through
 * lib/shell-run/shell-tool.ts). The base runs the commands, decides which
 * calls its guards block, and reports how a run ended. The profile words the
 * tools themselves (`ShellText`: descriptions, parameters, the primary-shell
 * guideline); the blocks, the results and the background notes are here
 * (`shellResultText`, built for the session's live tools). The command clips in a block, the output caps and the
 * "(no output)" detection stay in the base.
 */

import type { DescriptionForm } from "../profile/tool-variants.ts";
import { type LiveTools, type ToolPassages, withoutOff } from "../profile/live-tools.ts";
import { forLive } from "../profile/live-words.ts";

/** The PowerShell edition the description is written for. */
export type PowerShellEditionName = "core" | "desktop" | "unknown";

/** Why a guard blocked a shell call before it ran. */
export type ShellBlock =
	/** A foreground sleep: `shown` the sleep statements, `rest` what follows them (clipped), `sleepName` the shell's sleep command, `untilExample` its until-loop. */
	| { kind: "sleep"; shown: string; rest?: string; sleepName: string; untilExample: string }
	/** A foreground loop around a sleep; `command` clipped. */
	| { kind: "pollingLoop"; command: string }
	/** `via` is how it detaches, as code (`` `nohup` ``, `` `&` ``). */
	| { kind: "detach"; via: string }
	| { kind: "editor"; command: string }
	| { kind: "watch" }
	| { kind: "rebaseInteractive"; shell: "bash" | "powershell" }
	| { kind: "addInteractive" }
	/** A PowerShell command that waits on a console or GUI prompt. */
	| { kind: "consolePrompt"; command: string };

/** How a shell run ended. */
export type ShellEnd =
	| { kind: "stopped" }
	| { kind: "completed" }
	| { kind: "timedOut"; seconds?: number }
	| { kind: "signal"; signal?: string }
	| { kind: "exitCode"; code: number | null };

export interface ShellParams {
	command: string;
	timeout: string;
	description: string;
	run_in_background: string;
}

export interface ShellText {
	/** `searchTools`: the session has the dedicated grep, find and ls tools. */
	/** The system prompt guideline when PowerShell is the primary shell (Claude Code names it so). */
	powershellPrimary: string;
	bashDescription(p: { form: DescriptionForm; autoMode: boolean; searchTools: boolean }): string;
	bashParams: ShellParams;
	powershellDescription(p: { edition: PowerShellEditionName }): string;
	powershellParams: ShellParams;
}

/** The group's results, refusals and notes, which the base words (`shellResultText`). */
export interface ShellResultText {
	blocked(block: ShellBlock): string;
	/** A failed foreground command; `output` is what it printed, empty when nothing. */
	exitCode(p: { code: number; output: string }): string;
	/** `label` is the tool's display name (Bash, PowerShell). */
	noBackgroundShell(p: { label: string }): string;
	backgroundStarted(p: { label: string; id: string; description: string; logPath?: string }): string;
	/** How a run ended, as the one-shot result and the task notification put it ("completed", "failed (exit code 2)"). */
	finish(end: ShellEnd): string;
	/** Why a run failed when an exit code does not say (a timeout, a signal), for the task notification; undefined otherwise. */
	failureDetail(end: ShellEnd): string | undefined;
	/**
	 * A background command a one-shot run held to its end: `note` is the shared
	 * one-shot note, `deadline` set when it was stopped at its timeout,
	 * `output` its output or the file holding it.
	 */
	ranToEnd(p: {
		label: string;
		id: string;
		description: string;
		end: ShellEnd;
		note: string;
		deadline?: { timeoutMs: number; explicit: boolean; maxTimeoutMs: number };
		logPath?: string;
		output: string;
	}): string;
	/** A finished background command that printed nothing (never a blank, which reads as still running). */
	emptyOutput: string;
	/** Heads output cut to its last characters. */
	earlierTruncated: string;
	/** Heads a background command's output when its spool file could not be written. */
	spoolLost(p: { keptChars: number }): string;
}

function blocked(block: ShellBlock, live: LiveTools): string {
	switch (block.kind) {
		case "sleep": {
			const echo = block.rest ? `\`${block.shown}\` followed by: ${block.rest}` : `standalone \`${block.shown}\``;
			return (
				`Blocked: ${echo}. A foreground ${block.sleepName} stalls the whole session while it runs. ` +
				"To wait for a command you started, run it with run_in_background: true — its completion arrives as a task notification on its own, so you never need to poll. " +
				(live.has("monitor") ? `To wait for a condition, use the monitor tool with an until-loop (e.g. \`${block.untilExample}\`) — monitor is deferred, load it with tool_search select:monitor. ` : "") +
				"If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds. " +
				"Do not chain shorter sleeps to work around this block."
			);
		}
		case "pollingLoop":
			return (
				`Blocked: a foreground polling loop (\`${block.command}\`). It occupies the whole session while it spins. ` +
				(live.has("monitor")
					? "Use the monitor tool to run the until-loop for you (deferred — load it with tool_search select:monitor) — it returns when the condition holds — or start the underlying work with run_in_background: true and let its completion notification arrive on its own. "
					: "Start the underlying work with run_in_background: true and let its completion notification arrive on its own. ") +
				"Do not shorten the sleep or unroll the loop to work around this block."
			);
		case "detach":
			return (
				`Blocked: this command detaches a process with ${block.via}, leaving an orphan this session cannot manage — its output and exit status would be lost. ` +
				(live.has("task_output") && live.has("task_stop")
					? "Run it with run_in_background: true instead: it returns a task id immediately, completion arrives as a task notification, output stays readable with task_output, and it can be stopped with task_stop. "
					: "Run it with run_in_background: true instead: it returns a task id immediately and completion arrives as a task notification. ") +
				"If you need shell-level parallelism inside one command, end it with `wait` so the children are reaped."
			);
		case "editor":
			return `Blocked: \`${block.command}\` is an interactive editor and this shell has no TTY — it would hang until the timeout. Read files with the read tool and change them with ${live.has("edit") ? "edit/write" : "write"}.`;
		case "watch":
			return (
				"Blocked: `watch` needs an interactive terminal, which this shell does not have. " +
				`Use ${live.has("monitor") ? "the monitor tool (deferred — load it with tool_search select:monitor) to wait for a condition, or " : ""}run_in_background: true ${live.has("task_output") ? "with task_output to check on long-running output." : "for long-running output; its completion arrives as a task notification."}`
			);
		case "rebaseInteractive": {
			const accept = block.shell === "powershell" ? "`$env:GIT_SEQUENCE_EDITOR = ':'; git rebase …`" : "`GIT_SEQUENCE_EDITOR=: git rebase …`";
			return (
				"Blocked: `git rebase -i` opens an interactive editor, which this shell cannot provide — it would hang until the timeout. " +
				`Drive it non-interactively instead: ${accept} accepts the todo list as-is, or restructure history with \`git rebase --onto\`, \`git commit --amend\`, or \`git cherry-pick\`.`
			);
		}
		case "addInteractive":
			return (
				"Blocked: interactive `git add` prompts on a TTY this shell does not have — it would read EOF and stage nothing while appearing to succeed. " +
				"Stage whole files with `git add <paths>`, or stage a partial change non-interactively with `git apply --cached` and a crafted diff."
			);
		case "consolePrompt":
			return (
				`Blocked: \`${block.command}\` waits on a console or GUI prompt, and this shell runs -NonInteractive with stdin on the null device — it would error or hang until the timeout. ` +
				(live.has("ask_user_question") ? "Ask the user with ask_user_question instead, or pass the value on the command line." : "Pass the value on the command line instead.")
			);
	}
}

function failureDetail(end: ShellEnd): string | undefined {
	if (end.kind === "timedOut") return `timed out after ${end.seconds}s`;
	if (end.kind === "signal") return `terminated by ${end.signal ?? "unknown signal"}`;
	return undefined;
}

function finish(end: ShellEnd): string {
	if (end.kind === "stopped") return "stopped";
	if (end.kind === "completed") return "completed";
	return `failed (${failureDetail(end) ?? `exit code ${end.kind === "exitCode" ? end.code : ""}`})`;
}

const STARTED_PASSAGES: ToolPassages = {
	task_output: [" If your next step cannot proceed without the result, task_output with block=true waits for it."],
	task_stop: [" Stop with task_stop."],
};

/** The base's words of the group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const shellResultWords = (live: LiveTools): ShellResultText => ({
	blocked: (block) => blocked(block, live),
	// Claude Code's failure text: `Exit code N`, then the output on its own lines.
	exitCode: ({ code, output }) => (output === "" ? `Exit code ${code}` : `Exit code ${code}\n${output}`).trimEnd(),
	noBackgroundShell: ({ label }) => `No ${label} executable is available for a background run.`,
	backgroundStarted: ({ label, id, description, logPath }) =>
		withoutOff(
			`⏳ ${label} task ${id} running in background (${description}).\n\nCompletion will arrive as a task notification on its own naming the output file — you do not need to wait for it or poll; keep working.${logPath ? ` To check interim output, read ${logPath}.` : ""} If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.`,
			live,
			STARTED_PASSAGES,
		),
	finish,
	failureDetail,
	ranToEnd: ({ label, id, description, end, note, deadline, logPath, output }) => {
		const stopped = deadline
			? ` It was stopped at ${deadline.explicit ? `its ${deadline.timeoutMs} ms timeout` : `the default ${deadline.timeoutMs} ms timeout (no \`timeout\` was given)`}: a one-shot session cannot keep a background command running after the run ends, so a server or watcher started this way stops at the deadline. Pass a longer \`timeout\` (max ${deadline.maxTimeoutMs}) for a long build.`
			: "";
		return `${label} task ${id} (${description}) ${finish(end)}. ${note}${stopped}${logPath ? ` Log: ${logPath}.` : ""}\n\n${output}`;
	},
	emptyOutput: "(no output — the command wrote nothing to stdout or stderr)",
	earlierTruncated: "… (earlier output truncated)\n",
	spoolLost: ({ keptChars }) => `[The command's spool file could not be written, so only the last ${keptChars.toLocaleString("en-US")} characters of its output were kept.]\n`,
});

/** The words for this session's tools. */
export const shellResultText = forLive(shellResultWords);
