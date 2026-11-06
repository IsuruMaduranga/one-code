/**
 * What the shell tools (bash and powershell, through lib/shell-tool.ts) need
 * from a profile (types only). The base runs the commands, decides which
 * calls its guards block, and reports how a run ended; the profile words
 * all of it. The command clips in a block, the output caps and the
 * "(no output)" detection stay in the base.
 */

import type { DescriptionForm } from "./tool-variants.ts";

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
