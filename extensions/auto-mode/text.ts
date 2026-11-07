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

/**
 * The auto-mode classifier's ruleset (a side call's system prompt), split at
 * the insertion points the base fills: the `## Environment` slot lines after
 * `rulesetHead`, the user's hard-deny, soft-deny and allow rules after each
 * section, and the username in `sessionContext`. One Code's is Claude Code's
 * prompt, generated (profile/text/auto-mode/ruleset.ts).
 */
export interface ClassifierRuleset {
	rulesetHead: string;
	hardSection: string;
	softSection: string;
	allowSection: string;
	rulesetTail: string;
	/** The default `## Environment` slot lines, without the "- " bullet; a user's `autoMode.environment` replaces them. */
	defaultEnvironment: readonly string[];
	/** The Session Context block; `__USERNAME__` marks the username. */
	sessionContext: string;
	/** The user-role framing around the user's instruction file; the base sends none when there is no file. */
	instructionsFraming: { prefix: string; suffix: string };
	/** Stage 1's final instruction (harm only). */
	stage1Final: string;
	/** Stage 2's final instruction (intent and the allow exceptions). */
	stage2Final: string;
}

/** The classifier's prompt: the ruleset and the additions the base appends to stage 2 when their case holds. */
export interface ClassifierText extends ClassifierRuleset {
	/** Always after `stage2Final`: a block cleared on the user's intent must quote the user, which the base checks against the transcript. */
	stage2IntentAddendum: string;
	/** After it, when the transcript holds a permission-rule denial: a rule outranks the user's stated intent. */
	stage2DenialAddendum: string;
	/** After `stage2Final` in the completed-run subagent review: judge the finished run as a whole. */
	reviewAddendum: string;
	/** The `resolvedPaths` meta line's own explanation, which the ruleset has no sentence for. */
	resolvedPathsNote: string;
	/** One of the user's deny rules as a HARD BLOCK line (permissions/rule-prose.ts): `name` survives the rule-name scan, `spec` is the rule verbatim. */
	userDenyRule(name: string, spec: string): string;
}

/** The setup drafting call (`/auto-mode setup`): its instruction, and the notes on facts it could not gather. */
export interface AutoModeSetupText {
	/** The system prompt: the reply must be strict JSON with the keys the parser reads (`environment`, `allow`, `soft_deny`, `hard_deny`, `notes`). */
	system: string;
	/** The answers to "How do you use the product here?"; the chosen one reaches the facts as `usage`. */
	usageOptions: readonly string[];
	/** The heading above the default Environment slot lines in the user message. */
	defaultsHeading: string;
	/** The heading above the gathered facts, as JSON, in the user message. */
	factsHeading: string;
	/** Notes in the facts' `gatherNotes` on what could not be gathered. */
	notes: {
		probeFailed(what: string, command: string, error: string): string;
		unreadable(what: string, error: string): string;
		visibilityUnknown: string;
		noShellHistory: string;
		historyDeclined: string;
		allowUnreadable: string;
	};
}
