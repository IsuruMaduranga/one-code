/**
 * What the permission dialog shows for an ask (pure): the title, the subject,
 * the call's description and why the gate asks. Built only from what the gate
 * already has (the decision's cause and rule, the pause, the sandbox flag, the
 * asking subagent); nothing here decides anything. The plain-select title the
 * gate shows where the dialog cannot open stays `askTitle` in index.ts.
 */

import { ccToolName } from "../../lib/rules/hook-matcher.ts";
import { normalizeToolName, subjectKind } from "../../lib/rules/matcher.ts";
import type { PermissionDialogView } from "../../lib/ui/permission-dialog.ts";

export interface AskViewInput {
	toolName: string;
	/** The subject as the prompt previews it. */
	subject: string;
	/** The call's input, for a shell call's `description`. */
	input?: Record<string, unknown>;
	/** The `decide()` cause behind the prompt. */
	cause: string;
	/** The ask rule that matched, when the cause is a rule. */
	rule?: string;
	pausedResume: boolean;
	unsandboxed: boolean;
	/** The asking subagent: its name, null for an unnamed one, undefined for the main agent. */
	agent?: string | null;
	/** A reason the gate already showed for falling back to a prompt (auto mode's review could not run). */
	fallback?: string;
	options: string[];
}

/**
 * The dialog's title: "Bash command" for a shell call, as Claude Code titles
 * it; elsewhere the Claude Code tool name the rules and notifications use.
 */
export function askDialogTitle(toolName: string, unsandboxed = false): string {
	const tool = normalizeToolName(toolName);
	const name = ccToolName(tool);
	const title = subjectKind(tool) === "command" ? `${name} command` : name;
	return unsandboxed ? `${title} (unsandboxed)` : title;
}

/** Why the gate asks, in the order the reader needs it. */
function askNotes(input: AskViewInput): string[] {
	const notes: string[] = [];
	if (input.agent !== undefined) notes.push(input.agent ? `Requested by subagent ${input.agent}.` : "Requested by a subagent.");
	if (input.fallback) notes.push(input.fallback);
	if (input.pausedResume) notes.push("Auto mode is paused after repeated blocks. Approve to resume.");
	else if (input.cause === "protected-path") notes.push("This is a protected path. It configures your tooling or this agent, so allow rules do not pre-approve it.");
	else if (input.cause === "working-dir") notes.push("This is outside the working directory.");
	else if (input.cause === "plan-unproven") notes.push("Plan mode could not confirm this command only reads, so it asks you before running it.");
	else if (input.cause === "rule" && input.rule) notes.push(`The ask rule ${input.rule} matches this call.`);
	return notes;
}

export function askView(input: AskViewInput): PermissionDialogView {
	const description = subjectKind(input.toolName) === "command" && typeof input.input?.description === "string" ? input.input.description : undefined;
	return {
		title: askDialogTitle(input.toolName, input.unsandboxed),
		subject: input.subject || "(no arguments)",
		...(description ? { description } : {}),
		notes: askNotes(input),
		options: input.options,
	};
}
