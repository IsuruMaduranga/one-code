/**
 * Grounding the stage-2 verdict against CC's rule names (pure).
 *
 * Claude Code's stage-2 classifier emits `<category>Exact BLOCK Rule Name</category>`
 * when an action matches a BLOCK rule. CC itself discards that and shows a fixed
 * "Blocked by classifier"; we instead validate the category against an index of
 * the rule names actually present in the embedded ruleset, and derive the tier
 * (hard vs soft) from which section the name was found in — never from a field
 * the model chose freely.
 *
 * A block citing a category that does not exist is still a block, but tagged
 * `unmatched`, so a hallucinated name cannot borrow a real HARD rule's authority.
 * The rule's own name is what the user sees; the model's wording is kept as
 * commentary that is never mistaken for fact. This is decision 1 in
 * docs/decisions/auto-mode.md, re-expressed against CC's category scheme in
 * place of our old H1/S4/A2 ids.
 */

export type BlockTier = "hard_deny" | "soft_deny";

export interface IndexedRule {
	/** The rule's exact name as it appears in the ruleset (e.g. "Git Destructive"). */
	name: string;
	tier: BlockTier;
}

export interface RuleIndex {
	rules: IndexedRule[];
	/** Keyed by normalized name, for case/whitespace-insensitive lookup. */
	byName: Map<string, IndexedRule>;
}

/** Section headings in CC's ruleset that bound the block-rule lists. */
const HARD_HEADING = "## HARD BLOCK";
const SOFT_HEADING = "## SOFT BLOCK";
const ALLOW_HEADING = "## ALLOW (exceptions)";

/** Compare names ignoring case, surrounding punctuation, and whitespace runs. */
export function normalizeName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.,:;]+$/, "");
}

/**
 * The rule name at the head of a top-level bullet line, or undefined if the line
 * is not a rule entry. A rule line looks like `- Name [named+specifics …]: text`
 * or `- Name: text`; the name is what precedes the first ` [` qualifier or `:`.
 * Indented lines (sub-bullets) and non-bullet prose are ignored.
 */
function ruleNameFromLine(line: string): string | undefined {
	if (!line.startsWith("- ")) return undefined; // top-level bullets only
	const body = line.slice(2);
	// Cut at the first " [" (the [named+specifics …] qualifier) or the first ":".
	const bracket = body.indexOf(" [");
	const colon = body.indexOf(":");
	let end = body.length;
	if (bracket >= 0) end = Math.min(end, bracket);
	if (colon >= 0) end = Math.min(end, colon);
	const name = body.slice(0, end).replace(/\*/g, "").trim();
	return name.length > 0 ? name : undefined;
}

/** The text between two markers (exclusive), or "" if the bounds are missing. */
function sliceSection(text: string, from: string, to: string): string {
	const start = text.indexOf(from);
	if (start < 0) return "";
	const end = text.indexOf(to, start + from.length);
	return text.slice(start + from.length, end < 0 ? text.length : end);
}

function collectNames(section: string, tier: BlockTier, out: IndexedRule[], seen: Set<string>): void {
	for (const line of section.split("\n")) {
		const name = ruleNameFromLine(line);
		if (!name) continue;
		const key = normalizeName(name);
		if (seen.has(key)) continue; // a name appearing in two sections keeps its first (HARD) tier
		seen.add(key);
		out.push({ name, tier });
	}
}

/**
 * Parse the block-rule names out of the embedded ruleset. HARD BLOCK names win a
 * tie over SOFT (a HARD rule must never be downgraded by a same-named soft one).
 */
export function buildCategoryIndex(ruleset: string): RuleIndex {
	const rules: IndexedRule[] = [];
	const seen = new Set<string>();
	collectNames(sliceSection(ruleset, HARD_HEADING, SOFT_HEADING), "hard_deny", rules, seen);
	collectNames(sliceSection(ruleset, SOFT_HEADING, ALLOW_HEADING), "soft_deny", rules, seen);
	// ALLOW names are not block categories; they are intentionally not indexed, so
	// a block citing an allow name lands as `unmatched` rather than a real block.
	return { rules, byName: new Map(rules.map((rule) => [normalizeName(rule.name), rule])) };
}

/** Look up a category the classifier emitted. undefined ⇒ not a known BLOCK rule. */
export function groundCategory(index: RuleIndex, category: string | undefined): IndexedRule | undefined {
	if (!category) return undefined;
	return index.byName.get(normalizeName(category));
}
