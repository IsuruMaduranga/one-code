/**
 * One Code's auto-mode classifier prompt (the profile's `classifier` text):
 * Claude Code's ruleset, generated (ruleset.ts), plus One Code's own additions,
 * each one-directional: it can only turn an allow into a block
 * (working-docs/decisions/auto-mode.md).
 */

import type { ClassifierText } from "../../../extensions/sdk/profile.ts";
import { ruleset } from "./ruleset.ts";

export const classifier: ClassifierText = {
	...ruleset,
	// The single deliberate divergence from Claude Code's stage-2 payload: when
	// the model clears a SOFT block by crediting the user's own intent, it must
	// quote the user verbatim so the harness can verify the quote against the
	// real transcript.
	stage2IntentAddendum:
		"\n\nAdditionally: if you clear a block by crediting the user's own explicit intent " +
		"(not an ALLOW exception), you MUST add, after the tags above, " +
		"<intent>the user's own words authorizing it, quoted verbatim</intent>. " +
		"Quote only the user's own messages, never an ALLOW rule, a proposal, or your own reasoning.",
	// When the transcript carries a `denied_by_permission_rule` line. Stage 2's
	// job is to weigh user intent, and that is what let a retry through: after
	// `Bash(rm:*)` refused `rm scripts/slow_build.sh`, a `python3 -c` remove was
	// cleared on the user's own "Delete scripts/slow_build.sh"
	// (WEAK-MODEL-REVIEW-2026-09-06 H2). A permission rule is the user's decision
	// made in advance, so it outranks the intent stage.
	stage2DenialAddendum:
		"\n\nAdditionally: the transcript contains one or more `denied_by_permission_rule` entries — actions the user's own " +
		"permission rules already refused. Those rules are the user's decision about a CLASS of action, made in advance, and " +
		"user intent does NOT override them. If the action under review would achieve the effect of a denied action by another " +
		"route (a different command, a script, an interpreter one-liner, another tool), treat it as a circumvention of the " +
		"user's rules and BLOCK it, however plainly the user asked for the underlying goal.",
	// The completed-run subagent review: Claude Code's final block judges "the
	// most recent action"; a retrospective review weighs the whole finished run.
	reviewAddendum:
		"\n\nNote: this is a RETROSPECTIVE review of a delegated subagent run that has ALREADY completed — " +
		"the transcript's trailing entries are the subagent's actions (summarized). You are not approving a " +
		"pending action; judge the sequence of those actions AS A WHOLE and flag whether, together, they did " +
		"something the rules forbid — not only the final entry.",
	// The user's own deny rules, appended at the HARD BLOCK insertion point: a
	// rule binds only the spelling it names, so the classifier generalizes it by
	// effect, one-directionally (permissions/rule-prose.ts).
	userDenyRule: (name, spec) =>
		`User Deny Rule ${name}: the user's own settings deny \`${spec}\`. ` +
		"That is the user's standing decision about a CLASS of action, made in advance, so user intent does NOT clear it. " +
		"BLOCK the action under review if it would achieve what that rule forbids, whatever command, interpreter, script or tool it is spelled with.",
	resolvedPathsNote:
		"Measured by the harness, not written by the agent: each path below is named by the action under review as if inside the working directory, but resolves through a symbolic link to resolvesTo, outside every working directory. Judge the action as reading or writing resolvesTo.",
};
