/**
 * The permission gate's words for the model: why a call was refused, the
 * mode-change announcement and auto mode's standing note. The gate decides
 * (rules, modes, the workspace, the classifier's verdict, the child gate).
 * The classifier's denial and the outside-read refusals are worded the way
 * Claude Code words them. Prompts, panels and notifications are the user's
 * and are in the extension. The classifier's own reasons are auto mode's
 * words (safety/permissions/auto-mode/text.ts); the user's denial is the
 * shared tool-result text (lib/request/tool-results-text.ts).
 */

import { type LiveTools, type ToolPassages, withoutOff } from "../profile/live-tools.ts";
import { forLive } from "../profile/live-words.ts";
import { requireText } from "../profile/profile.ts";

/** Why the gate refused a call. */
export type PermissionRefusal =
	/** The call needs approval and nobody can give it in this session. */
	| { kind: "nonInteractive" }
	/** Plan mode allows only read-only tools and the plan file. */
	| { kind: "planMode" }
	/** A tool the profile turned off. */
	| { kind: "toolOff" }
	/** A file tool on a secret file of the profile's, or a command that names one. */
	| { kind: "secretFile" }
	/** dontAsk mode denies anything that would prompt. */
	| { kind: "dontAsk" }
	/** A write to a path that configures the user's tooling or the harness. */
	| { kind: "protectedPath" }
	/** A read outside the working directory, in dontAsk mode. */
	| { kind: "outsideWorkingDir" }
	/** The `blockReadsOutsideWorkingDirectories` setting refused a read. */
	| { kind: "outsideReadsBlocked" }
	/** The user just chose to block reads outside the working directories. */
	| { kind: "userBlockedOutsideReads" }
	/** Auto mode is paused and nobody answered the timed resume prompt. */
	| { kind: "unansweredResume" }
	/** A deny rule (`rule` as the settings spell it). */
	| { kind: "rule"; rule: string }
	/** The call spells its target in several path fields with different values. */
	| { kind: "conflictingPaths"; fields: string[] }
	/** The classifier denied the call; `reason` is the classifier's (auto mode's words). */
	| { kind: "classifierDenied"; reason: string }
	/** The classifier timed out; worth trying again. */
	| { kind: "classifierTimedOut"; reason: string }
	/** The classifier ran but gave no verdict. */
	| { kind: "classifierNoVerdict"; reason: string }
	/** The classifier's transcript outgrew its window in a session with no user to ask; the turn stops. */
	| { kind: "classifierOverflowHeadless" }
	/** The classifier's transcript outgrew its window and the user did not approve the call. */
	| { kind: "manualApprovalWithheld" }
	/** The turn (`who: "turn"`) or a child agent was stopped while the user's approval was pending. */
	| { kind: "stoppedWhileWaiting"; who: "turn" | "agent" }
	/** A child's gate could not reach the parent's decision. */
	| { kind: "bridgeFailed"; osMessage: string }
	/** The child or its parent session stopped before the decision. */
	| { kind: "childStopped" }
	/** An in-process child's own gate (no bridge): a deny rule, when one matched. */
	| { kind: "childDenied"; rule?: string }
	/** An in-process child in auto mode with no link to the classifier. */
	| { kind: "childNoClassifier"; outsideWorkingDir: boolean }
	/** An in-process child's call that needs the user's approval. */
	| { kind: "childNeedsApproval"; outsideWorkingDir: boolean };

// Must agree with the plan-mode reminder (plan-mode/reminder.ts): the plan is
// built in the plan file and approved through exit_plan_mode, never presented
// as chat text. A denial that said "present your plan to the user instead"
// contradicted the reminder in the same turn.
const PLAN_MODE =
	"You are in plan mode: only read-only tools may run, and edit/write are limited to the plan file. This call was blocked. Keep investigating with read-only tools and build the plan in the plan file named in the plan-mode reminder; finish the turn with ask_user_question or exit_plan_mode, not by presenting the plan as chat text.";

// Handed back to the model, not the user: auto mode exists to run unattended,
// so the model hears the block and can reach the goal a safe way (Claude
// Code's own auto-mode denial).
const classifierDenied = (reason: string) =>
	`Permission for this action was denied by the auto-mode approval classifier. Reason: ${reason}\n\n` +
	"If you have other tasks that don't depend on this action, continue with those. You *may* try to accomplish the goal a different, safe way (e.g. a less destructive command, or committing first so a change is recoverable), but do *not* try to work around or defeat this denial. If you believe this capability is essential, STOP and explain to the user what you were trying to do and why, and let them decide.";

const classifierTimedOut = (reason: string) =>
	`${reason}\n\nThis was not a judgement that the call is unsafe. Wait a moment and try this action again. ` +
	"If it keeps failing, continue with other tasks that do not require this action and come back to it later — " +
	"reading files, searching code, and other read-only operations do not require the classifier and can still be used. " +
	"Do not try to route around the gate; if this specific action is essential, tell the user what you were about to do so they can re-run interactively or switch the session model.";

// The classifier ran but gave no verdict (a provider refusal or error, a
// truncated reply, no usable model): not a denial, and nothing to route around.
const classifierNoVerdict = (reason: string) =>
	`${reason}\n\nThis was not a judgement that the call is unsafe: the approval classifier gave no verdict, so the call did not run. ` +
	"Do not rephrase it or route around the gate. Continue with other tasks that do not require this action — " +
	"reading files, searching code, and other read-only operations do not require the classifier. " +
	"If this action is essential, tell the user what you were about to do so they can re-run interactively or set another classifier model.";

function refused(refusal: PermissionRefusal, own: OwnWords): string {
	switch (refusal.kind) {
		case "nonInteractive":
			return "Permission required but this session is non-interactive, so the user cannot approve the call. It was blocked. Only pre-approved tools can run here; work within those, or ask the user to re-run interactively or with an allow rule / --dangerously-skip-permissions.";
		case "planMode":
			return PLAN_MODE;
		case "toolOff":
			return "That tool is not available in this harness, so the call was blocked. Continue with the tools you have.";
		case "secretFile":
			return own.secretFile ?? "That file holds secrets the user manages, so it cannot be read, written or named in a command here. Continue without its contents; if you need to know whether a value is set, ask the user.";
		case "dontAsk":
			return "Permission mode is dontAsk: anything that would normally prompt the user is denied instead. Only pre-approved tools can run; work within those, or tell the user which allow rule would unblock you.";
		case "protectedPath":
			return "That path is protected: it configures the user's tooling or this agent itself, so writes to it are never auto-approved and allow rules do not cover them. Achieve the goal another way, or ask the user to make the change.";
		case "outsideWorkingDir":
			return "That path is outside the working directory, which needs the user's approval, and permission mode is dontAsk (anything that would prompt is denied instead). Work inside the project, or tell the user which allow rule (e.g. Read(~/dir/**)) would unblock you.";
		case "outsideReadsBlocked":
			return "That path is outside the working directories; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.";
		case "userBlockedOutsideReads":
			return "The user chose to block reads outside the working directories (permissions.blockReadsOutsideWorkingDirectories). Ask the user to add the directory with /add-dir, or to remove that setting.";
		case "unansweredResume":
			return "Auto mode is paused after repeated blocks, and nobody answered the approval prompt for this call in time, so it was denied to avoid blocking an unattended session. Do not retry it; continue with work that does not need it, or stop and wait for the user.";
		// "Choose a different approach" is exactly what a literal reader does with
		// a second command of the same effect: a tiny-tier model met `Bash(rm:*)`
		// and deleted the file with `python3 -c "import os; os.remove(…)"` 3/3
		// times (WEAK-MODEL-REVIEW-2026-09-06 H2). A rule is the user's standing
		// decision about a CLASS of action, so the denial says equivalents are
		// denied too, as the classifier's own denial does.
		case "rule":
			return `This tool call is denied by the permission rule "${refusal.rule}" in the user's settings. The rule is the user's standing decision about this class of action: do not retry it, and do not achieve the same effect another way (a different command, a script, or another tool). Continue with work that does not depend on it, and tell the user what was denied and by which rule.`;
		case "conflictingPaths":
			return `This call names its target in ${refusal.fields.map((key) => `\`${key}\``).join(" and ")} with different values. Pass the target once, in the field the tool's schema defines.`;
		case "classifierDenied":
			return classifierDenied(refusal.reason);
		case "classifierTimedOut":
			return classifierTimedOut(refusal.reason);
		case "classifierNoVerdict":
			return classifierNoVerdict(refusal.reason);
		case "classifierOverflowHeadless":
			return "auto mode classifier transcript exceeded context window in headless mode";
		case "manualApprovalWithheld":
			return "Manual approval was not granted after the auto-mode classifier transcript exceeded its context window.";
		case "stoppedWhileWaiting":
			return `The ${refusal.who} was stopped while waiting for the user's approval.`;
		case "bridgeFailed":
			return `Permission bridge failed (${refusal.osMessage}); denied to fail safe.`;
		case "childStopped":
			return "The agent or its parent permission session has stopped; denied to fail safe.";
		case "childDenied":
			return `Denied by permission rules${refusal.rule ? ` (rule: ${refusal.rule})` : ""}.`;
		case "childNoClassifier":
			return `Auto mode's classifier is only reachable through the parent session, which this agent has no link to; a call${refusal.outsideWorkingDir ? " outside the working directory" : ""} is denied to fail safe.`;
		case "childNeedsApproval":
			return `This action${refusal.outsideWorkingDir ? " outside the working directory" : ""} needs interactive approval, which is not available inside an in-process agent. Ask for it to be added to the allow rules, or work around it.`;
	}
}

/** The plan-mode refusal names both plan tools (exit_plan_mode's entry first, so both apply when both are off). */
const REFUSAL_PASSAGES: ToolPassages = {
	exit_plan_mode: [
		[
			" Keep investigating with read-only tools and build the plan in the plan file named in the plan-mode reminder; finish the turn with ask_user_question or exit_plan_mode, not by presenting the plan as chat text.",
			" Keep investigating with read-only tools.",
		],
	],
	ask_user_question: [["finish the turn with ask_user_question or exit_plan_mode", "finish the turn with exit_plan_mode"]],
	edit: [["edit/write are limited to the plan file", "write is limited to the plan file"]],
};

/** The profile's own wording, where it has one. */
interface OwnWords {
	/** The refusal for a secret file (the text group `autoMode.secretFileRefusal`). */
	secretFile?: string;
}

/** The words, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const permissionWords = (live: LiveTools, own: OwnWords = {}) => ({
	/** Why the gate refused a call. */
	refused: (refusal: PermissionRefusal): string => withoutOff(refused(refusal, own), live, REFUSAL_PASSAGES),
	/** A switch of the permission mode; `planFile` when the mode is plan and its file is known. */
	modeChanged: ({ mode, planFile }: { mode: string; planFile?: string }): string => {
		const plan =
			mode !== "plan"
				? ""
				: planFile
					? ` Only read-only tools are available now, plus one writable file: your plan file at ${planFile}. Build the plan there, then call exit_plan_mode.`
					: " Only read-only tools are available now, plus the plan file named in the plan-mode reminder.";
		return `The user's permission mode is now "${mode}".${plan}`;
	},
	/** Auto mode's standing note, on every user message while auto mode is on. */
	autoModeActive:
		"Auto mode is active: your tool calls run without per-action prompts, but each one is screened by an approval classifier that blocks anything irreversible, destructive, or aimed outside this environment. " +
		"Work normally — do not narrate the classifier or try to phrase calls to get past it. If a call is blocked, take the block at face value: do not retry it, and do not reach the same result another way. Continue with work that does not depend on it, or explain what you were trying to do and let the user decide. " +
		"Attempting to weaken this gate (editing permission settings, changing the mode, or routing work around it) is itself blocked.",
	/** A child's run review that failed, as the reason in the hand-back warning. */
	reviewFailed: ({ osMessage }: { osMessage: string }): string => `the review itself failed (${osMessage})`,
});

/** The words for this session's tools (the profile in force), built once per live set. */
export const permissionText = forLive((live) => permissionWords(live, { secretFile: requireText("autoMode").secretFileRefusal }));

/** Why the gate refused a call, for the modules that run without the extension's own context (the in-process child gate, the parent bridge). */
export const refusalText = (refusal: PermissionRefusal): string => permissionText().refused(refusal);
