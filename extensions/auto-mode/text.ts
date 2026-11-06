/**
 * What auto mode needs from a profile for the session model (types only):
 * the note a session opening in auto mode gets, the retry note after the
 * user grants denied calls, and why a call was blocked (the classifier's
 * reasons and the safety floor's). The permission gate frames a block for
 * the model. The classifier's own prompt (the ruleset and its stage
 * instructions) and the `/auto-mode setup` drafting prompt move with the
 * ruleset (working-docs/features/profiles/plan.md, Phase 5).
 */


/** A classifier model that could not be used, and why. */
export interface UnusableClassifier {
	model: string;
	error: string;
}

/** Why the classifier blocked a call, or could not judge it. */
export type ClassifierBlock =
	/** Every candidate is gone and some refused the classifier's prompt (`refused` lists them). */
	| { kind: "noClassifierLeft"; refused: string[]; unusable: UnusableClassifier[] }
	| { kind: "noModel" }
	| { kind: "actionTooLong"; chars: number; max: number }
	| { kind: "cancelled" }
	| { kind: "transcriptTooLong"; model: string }
	/** The reply was cut off by its output limit before the verdict. */
	| { kind: "truncated" }
	/** `summary` is the provider error, shortened. */
	| { kind: "providerError"; summary: string }
	/** The classifier timed out or the network failed; `networkError` is set for the latter. */
	| { kind: "unavailable"; tool: string; model?: string; networkError?: string }
	| { kind: "noUsableModel"; lastError: string }
	/** The reply carried no severity. */
	| { kind: "noSeverity" }
	/** A clear resting on the user's intent that quotes no words of the user's. */
	| { kind: "intentUnverified" }
	/** A block naming a rule the ruleset does not have (`category` absent: it named none). */
	| { kind: "unmatchedRule"; category?: string };

/** What the safety floor found a call writing to. */
export interface FloorTarget {
	/** `catalog`: a model catalog; `pattern`: a wildcard or negated pattern that can select a control file; `control`: a settings file. */
	kind: "catalog" | "pattern" | "control";
	/** The path or pattern as the call spells it. */
	token: string;
}

export interface AutoModeText {
	/** The note for a session that opens in auto mode; `firm` for models that need the firmer wording. */
	systemNote(p: { firm: boolean }): string;
	/** After the user grants denied calls in /permissions; `displays` names each call. */
	permissionGranted(p: { displays: readonly string[] }): string;
	classifierBlock(block: ClassifierBlock): string;
	/** The floor's reason, also written to the decision log. */
	floorReason(target: FloorTarget): string;
	/** The block the model gets for a floor reason. */
	floorBlock(target: FloorTarget): string;
}
