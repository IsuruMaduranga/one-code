/**
 * Auto mode's words for the session model. The profile supplies the note a
 * session opening in auto mode gets (`AutoModeText`); the retry note after
 * the user grants denied calls and why a call was blocked (the classifier's
 * reasons and the safety floor's) are here (`autoModeResultText`). The
 * permission gate frames a block for the model. The classifier's own prompt (`ClassifierText`, the ruleset and
 * its stage instructions) and the `/auto-mode setup` drafting prompt
 * (`AutoModeSetupText`) are their own groups, below.
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

/** The profile's part: the note a session opening in auto mode gets. */
export interface AutoModeText {
	/** The note for a session that opens in auto mode; `firm` for models that need the firmer wording. */
	systemNote(p: { firm: boolean }): string;
}

function classifierBlock(block: ClassifierBlock): string {
	switch (block.kind) {
		case "noClassifierLeft": {
			const others = block.unusable.length > 0 ? ` ${block.unusable.map((u) => `${u.model} cannot be used (${u.error})`).join("; ")}.` : "";
			return `Auto mode has no classifier: ${block.refused.join(", ")} refused the classifier's prompt as a possible usage-policy violation.${others}`;
		}
		case "noModel":
			return "No model is available to run the auto-mode classifier.";
		case "actionTooLong":
			return `This call is ${block.chars} characters, more than the ${block.max} the auto-mode classifier reviews in full. Split it into smaller calls.`;
		case "cancelled":
			return "Auto-mode classification was cancelled.";
		case "transcriptTooLong":
			return `Classifier transcript exceeded context window (${block.model}). The action was not judged. Compact the session (/compact) and continue.`;
		case "truncated":
			return "The approval classifier's reply was cut off by its output limit before the verdict completed.";
		case "providerError":
			return `The auto-mode classifier returned no verdict (${block.summary}).`;
		case "unavailable": {
			const network = block.networkError !== undefined;
			return (
				`Auto mode could not screen this ${block.tool} call${network ? "" : " in time"} — the approval classifier${block.model ? ` (${block.model})` : ""} ` +
				`is temporarily unavailable (${network ? `network error: ${block.networkError}` : "timed out"}), so the call was not judged either way.`
			);
		}
		case "noUsableModel":
			return `No usable auto-mode classifier model (last error: ${block.lastError}).`;
		case "noSeverity":
			return "The approval classifier's reply carried no severity, so the verdict could not be read.";
		case "intentUnverified":
			return "The classifier cleared this as something the user asked for, but could not point to the user's own words asking for it.";
		case "unmatchedRule":
			return block.category
				? `The approval classifier blocked this as "${block.category}", which is not a rule that could be matched.`
				: "The approval classifier blocked this without naming a rule.";
	}
}

function floorReason({ kind, token }: FloorTarget): string {
	switch (kind) {
		case "catalog":
			return `it writes ${token}, a model catalog that decides the model tier the auto-mode checks that contain this agent depend on`;
		case "pattern":
			return `its pattern ${token} can select a file that holds the permission rules and auto-mode configuration that contain this agent`;
		case "control":
			return `it writes ${token}, which holds the permission rules and auto-mode configuration that contain this agent`;
	}
}

/** The base's words: the retry note after a grant, and why a call was blocked (the classifier's reasons and the safety floor's). */
export const autoModeResultText = {
	/** After the user grants denied calls in /permissions; `displays` names each call (Claude Code's retry note, findings §33). */
	permissionGranted: ({ displays }: { displays: readonly string[] }): string =>
		`Permission granted for: ${displays.join(", ")}. You may now retry ${displays.length === 1 ? "this command" : "these commands"} if you would like.`,
	classifierBlock,
	/** The floor's reason, also written to the decision log. */
	floorReason,
	/** The block the model gets for a floor reason. The floor re-checks a rewrite, and the classifier still judges it. */
	floorBlock: (target: FloorTarget): string => {
		const opening = `Auto mode blocked this call without consulting the classifier: ${floorReason(target)}.`;
		if (target.kind === "pattern") {
			return `${opening} A command that may touch the gate's own configuration is never auto-approved. If this is a read-only search, rewrite it without the wildcard or negated pattern (for example \`grep -r --exclude-dir=node_modules\`); otherwise ask the user to run it themselves.`;
		}
		return `${opening} Writes to the gate's own configuration are never auto-approved. Do not retry or route around this; ask the user to make the change themselves.`;
	},
};

/**
 * The auto-mode classifier's ruleset (a side call's system prompt), split at
 * the insertion points the base fills: the `## Environment` slot lines after
 * `rulesetHead`, the user's hard-deny, soft-deny and allow rules after each
 * section, and the username in `sessionContext`. One Code's is Claude Code's
 * prompt, generated (profile/text/auto-mode/ruleset.ts).
 *
 * The base also reads the assembled text, so a ruleset must keep three shapes:
 * the rule lists sit under the headings `## HARD BLOCK`, `## SOFT BLOCK` and
 * `## ALLOW (exceptions)`, each rule a top-level `- Name: …` bullet
 * (rules.ts, which maps a cited block to its rule); and the stage finals ask
 * for the reply tags prompt.ts parses (`<severity>`, `<category>`, `<intent>`).
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
	/** One of the user's deny rules as a HARD BLOCK line (safety/permissions/rule-prose.ts): `name` survives the rule-name scan, `spec` is the rule verbatim. */
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
