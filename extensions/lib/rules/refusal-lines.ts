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

/** The first sentence of auto mode's denial. */
export const CLASSIFIER_DENIED = "Permission for this action was denied by the auto-mode approval classifier.";

/** Claude Code's row for an auto-mode denial, without its "· /feedback if incorrect" (One Code has no /feedback). */
export const CLASSIFIER_DENIED_LINE = "Denied by auto mode classifier";

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

const LEAD_LINES: Record<keyof typeof REFUSAL_LEADS, string> = {
	nonInteractive: "Needs approval, but this session cannot ask for it",
	planMode: "Blocked in plan mode",
	toolOff: "Tool not available",
	secretFile: "Blocked: the file holds secrets",
	dontAsk: "Denied in dontAsk mode",
	protectedPath: "Blocked: protected path",
	outsideWorkingDir: "Denied in dontAsk mode: outside the working directory",
	outsideReadsBlocked: "Blocked: outside the working directories",
	userBlockedOutsideReads: "Blocked: outside the working directories",
	unansweredResume: "Denied: the approval prompt went unanswered",
	childNoClassifier: "Denied: this agent cannot reach auto mode's classifier",
};

/** A deny rule's refusal; the rule as the settings spell it goes between the quotes. */
export const ruleRefusalLead = (rule: string) => `This tool call is denied by the permission rule "${rule}" in the user's settings.`;
const RULE_LEAD = /^This tool call is denied by the permission rule "(.*)" in the user's settings\./;

/** A child's call that needs the user's approval; `where` is empty or " outside the working directory". */
export const childNeedsApprovalLead = (where: string) => `This action${where} needs interactive approval, which is not available inside an in-process agent.`;
const CHILD_NEEDS_APPROVAL_LEAD = /^This action( outside the working directory)? needs interactive approval, which is not available inside an in-process agent\./;

/**
 * Where the model's guidance begins in a refusal whose opening is already
 * the fact the user needs. The transcript shows the text before it.
 */
export const GUIDANCE_STARTS = {
	/** The safety floor's refusal of a wildcard or negated pattern (auto-mode/text.ts). */
	floorPattern: " A command that may touch the gate's own configuration is never auto-approved.",
	/** The safety floor's refusal of a write (auto-mode/text.ts). */
	floorWrite: " Writes to the gate's own configuration are never auto-approved.",
	/** A worktree-isolated session's git command (worktree-guard-text.ts). */
	worktreeGit: " Refusing to run it — a worktree-isolated session's git operations must target its own worktree.",
	/** A risky `git stash` in a worktree (worktree-guard-text.ts). */
	worktreeStash: " Prefer a temporary WIP commit on this worktree's branch to set work aside.",
	/** An isolated agent's write to the shared checkout (worktree-guard-text.ts). */
	worktreeWrite: " Refusing the write — an isolated agent's changes belong in its own worktree.",
	/** A call while the active worktree is gone (safety/worktree/text.ts). */
	worktreeMissing: ' Use exit_worktree with action: "keep" to return to ',
	/** A write that carries a secret placeholder (tool-results-text.ts). */
	secretPlaceholder: " It stands for a real value the file holds, which you were not shown;",
	/** A call whose arguments look cut off (tool-call-corruption/text.ts). */
	suspectCall: " It was not run. Send the complete command again;",
	/** A call whose arguments came through corrupt (tool-call-corruption/text.ts). */
	corruptCall: " Do not retry this call; switch models or exclude the upstream provider.",
} as const;

/** A short transcript line and its colour token: a dim note for a refusal working as intended, an error's for a failure. */
export interface RefusalLine {
	text: string;
	color: "error" | "dim";
}

/** Whether a tool result is auto mode's denial. */
export function isClassifierDenial(text: string): boolean {
	return text.startsWith(CLASSIFIER_DENIED);
}

/**
 * The transcript line for a harness refusal, or undefined when the text is
 * not one. Only the fact is kept: a short line for the permission gate's
 * fixed refusals, the text before the model's guidance for the others.
 * Whitespace runs fold to one space, so the line stays one line.
 */
export function refusalLine(text: string): RefusalLine | undefined {
	if (isClassifierDenial(text)) return { text: CLASSIFIER_DENIED_LINE, color: "dim" };
	const notJudged = text.indexOf(CLASSIFIER_NOT_JUDGED);
	if (notJudged > 0) return { text: oneLine(text.slice(0, notJudged)), color: "error" };
	for (const [kind, lead] of Object.entries(REFUSAL_LEADS) as Array<[keyof typeof REFUSAL_LEADS, string]>) {
		if (text.startsWith(lead)) return { text: LEAD_LINES[kind], color: "dim" };
	}
	const rule = RULE_LEAD.exec(text);
	if (rule) return { text: `Denied by permission rule ${rule[1]}`, color: "dim" };
	if (CHILD_NEEDS_APPROVAL_LEAD.test(text)) return { text: "Needs approval, which an agent cannot ask for", color: "dim" };
	for (const start of Object.values(GUIDANCE_STARTS)) {
		const at = text.indexOf(start);
		const failed = start === GUIDANCE_STARTS.suspectCall || start === GUIDANCE_STARTS.corruptCall;
		if (at > 0) return { text: oneLine(text.slice(0, at)), color: failed ? "error" : "dim" };
	}
	return undefined;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
