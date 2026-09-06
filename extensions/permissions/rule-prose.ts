/**
 * The user's own deny rules, rendered for the approval classifier (pure).
 *
 * A permission rule binds the spelling it names and nothing else. `Bash(rm:*)`
 * refuses `rm scripts/build.sh` and has no opinion about
 * `python3 -c "import os; os.remove('scripts/build.sh')"`, which is how a
 * tiny-tier model deleted the file anyway, 3 times out of 3
 * (WEAK-MODEL-REVIEW-2026-09-06 H2). The rule cannot be widened
 * deterministically — an earlier attempt remembered the denied path and refused
 * every later call naming it, which caught the retry but also refused a
 * harmless later edit of the same file for the rest of the session, and never
 * caught a FIRST attempt (nothing has been denied yet, so there is nothing to
 * remember).
 *
 * Only something that judges by effect can generalize a rule, so the rules go
 * to the classifier. This is one-directional, like every other model layer
 * here: the rule still fires deterministically on its literal form before any
 * model is consulted, so the classifier can only add blocks the spelling missed
 * and can never clear something a rule already refused.
 *
 * The lines are appended at Claude Code's own HARD BLOCK injection point
 * (`classifier-prompt.ts buildRuleset`), which is the sanctioned append-only
 * surface, so prompt fidelity is untouched. They are indexed by the same scan
 * as the built-in rules (`rules.ts`), so a verdict citing one grounds.
 */

import { parseRule } from "./matcher.ts";

/** Bound on how many rules are described, so a long deny list cannot dominate the ruleset. */
const MAX_RULES = 25;

/**
 * Bound on the quoted rule spec, so a pathological pattern cannot dominate
 * either. The bound is on the SPEC and not on the finished line: clipping the
 * line would cut the instruction off its own rule.
 */
const MAX_SPEC = 120;

/**
 * A rule name must survive `ruleNameFromLine`, which cuts at the first `:` or
 * ` [`. Rule specs contain both (`Bash(rm:*)`, `Read(~/**)`), so the name
 * carries a punctuation-stripped form and the verbatim spec goes in the body.
 */
function nameFragment(spec: string): string {
	// The rule's own spelling, not the normalized tool name: this name is what the
	// user is shown when a verdict cites the rule, so `WebFetch` should not come
	// back as `web_fetch`.
	const cleaned = spec
		.replace(/[:[\]`*()]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.slice(0, 60).trim();
}

/**
 * One HARD BLOCK line per deny rule. `ask` rules are deliberately NOT rendered:
 * an ask rule asks for a decision, and auto mode already routes those to the
 * classifier — turning them into block rules would convert "check with me" into
 * "never", which is not what the user wrote.
 */
export function denyRuleLines(deny: readonly string[]): string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const raw of deny) {
		if (lines.length >= MAX_RULES) break;
		const rule = parseRule(raw);
		if (!rule) continue;
		const full = rule.raw.replace(/[\n\r]+/g, " ").trim();
		if (!full || seen.has(full)) continue;
		seen.add(full);
		const spec = full.length > MAX_SPEC ? `${full.slice(0, MAX_SPEC - 1)}…` : full;
		lines.push(
			`User Deny Rule ${nameFragment(spec)}: the user's own settings deny \`${spec}\`. ` +
				"That is the user's standing decision about a CLASS of action, made in advance, so user intent does NOT clear it. " +
				"BLOCK the action under review if it would achieve what that rule forbids, whatever command, interpreter, script or tool it is spelled with.",
		);
	}
	return lines;
}
