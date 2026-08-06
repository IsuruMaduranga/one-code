/**
 * Rule indexing and verdict grounding (pure).
 *
 * The classifier used to return a free-text reason, and a model required to
 * justify a decision it has no grounds for produces the most plausible-sounding
 * justification instead of a true one: a `.claude/notes.md` write came back
 * blocked "because it is outside the working directory", which was false. That
 * reason is what the user reads in `/permissions`, what the model is told to act
 * on, and — via the tier — what decides whether the user even gets a prompt.
 *
 * So rules are numbered here, the classifier cites an id, and the id is
 * validated against this index. What the user sees is the *rule's own text*, not
 * the model's paraphrase of it, and the tier comes from the cited id's prefix
 * rather than from a field the model was free to invent. The model's own wording
 * is kept, but as commentary that is never mistaken for fact.
 *
 * Claude Code went further and stopped showing a reason at all (v2.1.208 shows a
 * fixed "Blocked by classifier"), having shipped written explanations first and
 * moved off them. Keeping the explanation is worth it — it is how a user knows
 * which rule or environment entry to change — but only if it cannot assert
 * things that are not so.
 */

import type { AutoModeConfig } from "./config.ts";

export type RuleTier = "hard_deny" | "soft_deny" | "allow";

export interface IndexedRule {
	/** `H1`, `S4`, `A2` — what the classifier cites. */
	id: string;
	tier: RuleTier;
	/** The rule's full text, as configured. */
	text: string;
	/** Short human-readable name, for a one-line denial listing. */
	label: string;
}

const TIER_PREFIX: Record<RuleTier, string> = { hard_deny: "H", soft_deny: "S", allow: "A" };

/**
 * Grounds for a block that are real but are not numbered rules. Without these
 * the classifier would have to force such a decision onto whichever rule looked
 * closest, which is the misattribution this module exists to stop.
 */
export const RESERVED_BLOCK_IDS: Record<string, { reason: string; tier: "soft_deny" }> = {
	boundary: {
		reason: "The user stated a boundary in this conversation that this action would cross.",
		tier: "soft_deny",
	},
	instructions: {
		reason: "The project's own instruction file forbids this.",
		tier: "soft_deny",
	},
	unclear: {
		reason: "What this action would do could not be determined from the call, so it was not allowed.",
		tier: "soft_deny",
	},
};

/**
 * A rule's display name: the part before the first colon, with any
 * `[must name …]` qualifier stripped. Falls back to a clipped prefix for a
 * user-written rule with no such structure.
 */
export function ruleLabel(text: string): string {
	const head = text.split(":")[0] ?? text;
	const stripped = head.replace(/\[[^\]]*\]/g, "").trim();
	const candidate = stripped || head.trim();
	if (candidate.length > 0 && candidate.length <= 60 && candidate.length < text.length) return candidate;
	return `${text.slice(0, 57).trim()}…`;
}

export interface RuleIndex {
	rules: IndexedRule[];
	byId: Map<string, IndexedRule>;
}

/** Number every rule so a verdict can point at one. */
export function indexRules(config: AutoModeConfig): RuleIndex {
	const rules: IndexedRule[] = [];
	const tiers: RuleTier[] = ["hard_deny", "soft_deny", "allow"];
	for (const tier of tiers) {
		const entries = config[tier];
		for (const [position, text] of entries.entries()) {
			rules.push({ id: `${TIER_PREFIX[tier]}${position + 1}`, tier, text, label: ruleLabel(text) });
		}
	}
	return { rules, byId: new Map(rules.map((rule) => [rule.id, rule])) };
}

/** Render one tier for the prompt, with ids the classifier can cite. */
export function renderTier(index: RuleIndex, tier: RuleTier): string {
	const entries = index.rules.filter((rule) => rule.tier === tier);
	if (entries.length === 0) return "";
	return `<${tier}>\n${entries.map((rule) => `${rule.id}. ${rule.text}`).join("\n")}\n</${tier}>`;
}
