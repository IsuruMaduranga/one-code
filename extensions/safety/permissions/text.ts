/**
 * What the permission gate needs from a profile (types only). The base
 * decides (rules, modes, the workspace, the classifier's verdict, the child
 * gate) and the profile words what the model hears: why a call was refused,
 * a mode change, auto mode's standing note. Prompts, panels and
 * notifications are the user's and stay in the base. The classifier's own
 * reasons are auto mode's words (safety/permissions/auto-mode/text.ts); the user's denial is
 * the shared tool-result text (lib/request/tool-results-text.ts). Deep modules reach
 * the words through `words.ts`.
 */

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

export interface PermissionsText {
	refused(refusal: PermissionRefusal): string;
	/** A switch of the permission mode; `planFile` when the mode is plan and its file is known. */
	modeChanged(p: { mode: string; planFile?: string }): string;
	/** Auto mode's standing note, on every user message while auto mode is on. */
	autoModeActive: string;
	/** A child's run review that failed, as the reason in the hand-back warning. */
	reviewFailed(p: { osMessage: string }): string;
}
