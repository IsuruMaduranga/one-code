/**
 * The fixed parts of the harness's refusals (pure, no words in force) and
 * the transcript line each one gets. A refusal tells the model what happened
 * and what to do next; the user needs only what happened. pi turns a blocked
 * call into an error result that carries the reason's text alone (no
 * `details`, agent-loop.ts `prepareToolCall`), so the transcript recognizes a
 * refusal by these words, which the text modules build their refusals from:
 * permission-text.ts, auto-mode/text.ts (the safety floor),
 * worktree-guard-text.ts, safety/worktree/text.ts, tool-results-text.ts and
 * tool-call-corruption/text.ts. lib/ui/tui-render.ts `rejectionLine` draws
 * the line. The model always reads the whole text.
 */

import type { ShortLine } from "../ui/tui-render.ts";
import { sanitizeTitle } from "../ui/terminal-text.ts";

/** The first sentence of auto mode's denial. */
export const CLASSIFIER_DENIED = "Permission for this action was denied by the auto-mode approval classifier.";

/**
 * Claude Code's row for an auto-mode denial (2.1.332, findings §103), without
 * the link to its docs. The transcript adds the review hint and the reason
 * line (lib/ui/tui-render.ts `rejectionLine`).
 */
export const CLASSIFIER_DENIED_LINE = "Blocked by auto mode";

/** What sits between the denial's first sentence and its reason (permission-text.ts `classifierDenied`). */
const CLASSIFIER_REASON_LEAD = `${CLASSIFIER_DENIED} Reason: `;

/**
 * The opening of the guidance after auto mode's reason when the classifier
 * timed out or gave no verdict.
 */
export const CLASSIFIER_NOT_JUDGED = "\n\nThis was not a judgement that the call is unsafe";

/** The opening sentences of the permission gate's refusals that the transcript draws as a short line of its own. */
export const REFUSAL_LEADS = {
	nonInteractive: "Permission required but this session is non-interactive, so the user cannot approve the call.",
	planMode: "You are in plan mode: only read-only tools may run",
	toolOff: "That tool is not available in this harness, so the call was blocked.",
	secretFile: "That file holds secrets the user manages, so it cannot be read, written or named in a command here.",
	dontAsk: "Permission mode is dontAsk: anything that would normally prompt the user is denied instead.",
	protectedPath: "That path is protected: it configures the user's tooling or this agent itself",
	outsideWorkingDir: "That path is outside the working directory, which needs the user's approval, and permission mode is dontAsk",
	outsideReadsBlocked: "That path is outside the working directories; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories.",
	userBlockedOutsideReads: "The user chose to block reads outside the working directories (permissions.blockReadsOutsideWorkingDirectories).",
	unansweredResume: "Auto mode is paused after repeated blocks, and nobody answered the approval prompt for this call in time",
	childNoClassifier: "Auto mode's classifier is only reachable through the parent session, which this agent has no link to",
} as const;

/** A deny rule's refusal; the rule as the settings spell it goes between the quotes. */
export const ruleRefusalLead = (rule: string) => `This tool call is denied by the permission rule "${rule}" in the user's settings.`;

/** A child's call that needs the user's approval; `where` is empty or " outside the working directory". */
export const childNeedsApprovalLead = (where: string) => `This action${where} needs interactive approval, which is not available inside an in-process agent.`;

/**
 * Where the model's guidance begins in a refusal whose opening is already
 * the fact the user needs; each follows a space in the text. The transcript
 * shows the text before it.
 */
export const GUIDANCE = {
	/** The safety floor's refusal of a wildcard or negated pattern (auto-mode/text.ts). */
	floorPattern: "A command that may touch the gate's own configuration is never auto-approved.",
	/** The safety floor's refusal of a write (auto-mode/text.ts). */
	floorWrite: "Writes to the gate's own configuration are never auto-approved.",
	/** A worktree-isolated session's git command (worktree-guard-text.ts). */
	worktreeGit: "Refusing to run it — a worktree-isolated session's git operations must target its own worktree.",
	/** A risky `git stash` in a worktree (worktree-guard-text.ts). */
	worktreeStash: "Prefer a temporary WIP commit on this worktree's branch to set work aside.",
	/** An isolated agent's write to the shared checkout (worktree-guard-text.ts). */
	worktreeWrite: "Refusing the write — an isolated agent's changes belong in its own worktree.",
	/** A call while the active worktree is gone, before the original directory (safety/worktree/text.ts). */
	worktreeMissing: 'Use exit_worktree with action: "keep" to return to',
	/** A write that carries a secret placeholder, before the rest of its sentence (tool-results-text.ts). */
	secretPlaceholder: "It stands for a real value the file holds, which you were not shown;",
	/** A call whose arguments look cut off, before the rest of its sentence (tool-call-corruption/text.ts). */
	suspectCall: "It was not run. Send the complete command again;",
	/** A call whose arguments came through corrupt (tool-call-corruption/text.ts). */
	corruptCall: "Do not retry this call; switch models or exclude the upstream provider.",
} as const;

/** How the safety floor's refusal opens, before its reason (auto-mode/text.ts). */
export const FLOOR_OPENING = "Auto mode blocked this call without consulting the classifier: ";

/** Whether a tool result is auto mode's denial. */
export function isClassifierDenial(text: string): boolean {
	return text.startsWith(CLASSIFIER_DENIED);
}

/**
 * The classifier's reason in auto mode's denial, or undefined when the text
 * is not one. An empty reason reads "No reason provided", as Claude Code's does.
 */
export function classifierDenialReason(text: string): string | undefined {
	if (!text.startsWith(CLASSIFIER_REASON_LEAD)) return undefined;
	const reason = text.slice(CLASSIFIER_REASON_LEAD.length).split("\n\n")[0].trim();
	return sanitizeTitle(reason) || "No reason provided";
}

/** A template's text as a pattern that matches any value in its slot, captured. */
function templatePattern(template: (slot: string) => string): RegExp {
	const SLOT = "\u0000";
	const escaped = template(SLOT).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(SLOT, "(.*)")}`);
}

type Recognizer = (text: string) => string | undefined;
const opensWith = (lead: string, line: string): Recognizer => (text) => (text.startsWith(lead) ? line : undefined);
const matches = (pattern: RegExp, line: (slot: string) => string): Recognizer => (text) => {
	const found = pattern.exec(text);
	return found ? line(found[1]) : undefined;
};
/**
 * The text before `guidance`, for a refusal that also opens with `start` or
 * ends with `end`: a phrase alone could sit anywhere in a failed command's
 * output (a test that prints these refusals), and that output must stay whole.
 * refusal-lines.test.ts checks every anchor against the text modules' words.
 */
const before = (guidance: string, anchor: { start: string } | { end: string }): Recognizer => (text) => {
	if ("start" in anchor ? !text.startsWith(anchor.start) : !text.endsWith(anchor.end)) return undefined;
	const at = text.indexOf(guidance);
	return at > 0 ? text.slice(0, at) : undefined;
};

/** Each refusal's recognizer and colour: dim for a refusal working as intended, an error's for a failure. In order. */
const REFUSALS: ReadonlyArray<{ line: Recognizer; color: ShortLine["color"] }> = [
	{ line: opensWith(CLASSIFIER_DENIED, CLASSIFIER_DENIED_LINE), color: "dim" },
	{ line: before(CLASSIFIER_NOT_JUDGED, { end: "so they can re-run interactively or switch the session model." }), color: "error" },
	{ line: before(CLASSIFIER_NOT_JUDGED, { end: "so they can re-run interactively or set another classifier model." }), color: "error" },
	{ line: opensWith(REFUSAL_LEADS.nonInteractive, "Needs approval, but this session cannot ask for it"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.planMode, "Blocked in plan mode"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.toolOff, "Tool not available"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.secretFile, "Blocked: the file holds secrets"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.dontAsk, "Denied in dontAsk mode"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.protectedPath, "Blocked: protected path"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.outsideWorkingDir, "Denied in dontAsk mode: outside the working directory"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.outsideReadsBlocked, "Blocked: outside the working directories"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.userBlockedOutsideReads, "Blocked: outside the working directories"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.unansweredResume, "Denied: the approval prompt went unanswered"), color: "dim" },
	{ line: opensWith(REFUSAL_LEADS.childNoClassifier, "Denied: this agent cannot reach auto mode's classifier"), color: "dim" },
	{ line: matches(templatePattern(ruleRefusalLead), (rule) => `Denied by permission rule ${rule}`), color: "dim" },
	{ line: matches(templatePattern(childNeedsApprovalLead), () => "Needs approval, which an agent cannot ask for"), color: "dim" },
	{ line: before(` ${GUIDANCE.floorPattern}`, { start: FLOOR_OPENING }), color: "dim" },
	{ line: before(` ${GUIDANCE.floorWrite}`, { start: FLOOR_OPENING }), color: "dim" },
	{ line: before(` ${GUIDANCE.worktreeGit}`, { start: "This session is isolated in the worktree " }), color: "dim" },
	{ line: before(` ${GUIDANCE.worktreeStash}`, { start: "Blocked: `" }), color: "dim" },
	{ line: before(` ${GUIDANCE.worktreeWrite}`, { start: "This agent is isolated in the worktree " }), color: "dim" },
	{ line: before(` ${GUIDANCE.worktreeMissing}`, { start: "The active worktree at " }), color: "dim" },
	{ line: before(` ${GUIDANCE.secretPlaceholder}`, { start: "This write contains a [secret] placeholder." }), color: "dim" },
	{ line: before(` ${GUIDANCE.suspectCall}`, { end: "drop the trailing blank or the empty option." }), color: "error" },
	{ line: before(` ${GUIDANCE.corruptCall}`, { start: "OpenRouter tool-call corruption: " }), color: "error" },
];

/**
 * The transcript line for a harness refusal, or undefined when the text is
 * not one: the first recognizer that knows it, folded to one line.
 */
export function refusalLine(text: string): ShortLine | undefined {
	for (const { line, color } of REFUSALS) {
		const shown = line(text);
		if (shown !== undefined) return { text: sanitizeTitle(shown), color };
	}
	return undefined;
}
