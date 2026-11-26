/**
 * Classifier payload assembly and stage-verdict parsing (pure).
 *
 * The payload is Claude Code's shape (working-docs/decisions/auto-mode.md, P4/P5):
 *   system = <ruleset with Environment spliced> + <Session Context>
 *   user   = <CLAUDE.md framing> + <transcript> + <stage final instruction>
 * The two stages share system+framing+transcript byte-for-byte and differ only
 * in the final instruction block, so stage 2 is a cache hit off stage 1.
 *
 * Kept free of any pi/network import so the exact text sent, and the parsing of
 * what comes back, are unit-testable.
 */

import { buildRuleset, classifierText, instructionsFraming, renderSessionContext, type RuleExtras } from "./classifier-prompt.ts";
import { buildCategoryIndex, groundCategory, type RuleIndex } from "./rules.ts";
import { clip, transcriptBlocks, type TranscriptEntry } from "./transcript.ts";
import { autoModeResultText } from "./text.ts";

export interface ClassifyRequest {
	/**
	 * The active transcript: user messages, compaction context, and tool inputs
	 * (results stripped). Its **last entry is the action under review** — the
	 * caller appends the call being judged before handing it here.
	 */
	transcript: TranscriptEntry[];
	/** The user's CLAUDE.md, wrapped in the (untrusted) framing block. */
	claudeMd?: string;
	/** Session identity for the Session Context block. */
	username: string;
	/** Environment slot lines (AutoModeConfig.environment) spliced into the ruleset. */
	environment: string[];
	/** User rule extras (AutoModeConfig hard_deny/soft_deny/allow) appended at CC's injection points. */
	ruleExtras?: RuleExtras;
	/** Native tool name of the action under review — for logging/debug only. */
	toolName: string;
}

export type ClassifyDecision = "allow" | "block";

export interface ClassifyVerdict {
	decision: ClassifyDecision;
	/** Shown to the user and the model: the grounded rule name, never a paraphrase. */
	reason: string;
	/** Derived from the grounded category's section, not a field the model chose. */
	tier?: "hard_deny" | "soft_deny" | "allow" | "unmatched" | "timeout";
	/** The grounded rule name (or a sentinel like `unverified-clear`). */
	ruleId?: string;
	/** The model's own wording, kept for diagnosis and shown attributed to it. */
	raw?: string;
	/**
	 * Set when no classifier verdict was reached (no model, a failure, a
	 * timeout, an action too large to send): the block judged nothing, so it is
	 * not offered for approval in `/permissions` (Claude Code's `noVerdict`).
	 */
	noVerdict?: true;
	/** The provider could not fit the whole transcript; no safety verdict was reached. */
	transcriptTooLong?: true;
}

/**
 * Build the shared payload plus the grounding index. The ruleset (~110 KB) is
 * built once here and used for both the system prompt and the category index, so
 * `classify()` does not rebuild and re-parse it a second time per call. The final
 * instruction is appended per stage by the caller (stage1User / stage2User).
 */
export function buildPayload(request: ClassifyRequest): { system: string; userPrefix: string; history: string[]; tail: string; index: RuleIndex } {
	const ruleset = buildRuleset(request.environment, request.ruleExtras);
	const system = ruleset + renderSessionContext(request.username);
	const framing = instructionsFraming(request.claudeMd);
	const { history, tail } = transcriptBlocks(request.transcript);
	if (framing) history[0] = `${framing}\n\n${history[0]}`;
	const userPrefix = history.join("") + tail;
	return { system, userPrefix, history, tail, index: buildCategoryIndex(ruleset) };
}

/** The stage-1 user message: shared prefix + the harm-only final instruction. */
export function stage1User(userPrefix: string): string {
	return `${userPrefix}\n\n${classifierText().stage1Final.trimStart()}`;
}

/**
 * The stage-2 user message: shared prefix + full-eval final, plus the
 * profile's denial addendum when the transcript holds a rule denial (a
 * permission rule outranks the user's stated intent).
 */
export function stage2User(userPrefix: string, afterRuleDenial = false): string {
	const text = classifierText();
	return `${userPrefix}\n\n${text.stage2Final.trimStart()}${afterRuleDenial ? text.stage2DenialAddendum : ""}`;
}

/**
 * The whole number inside the last `<severity>…` tag (closing tag optional),
 * or null. The body must be the number and nothing else: a model answering on
 * another scale (`0.9`, `9/10`, `90%`) gives a body whose leading digits are
 * not its severity, and reading them cleared stage 1 with no stage 2. Null
 * falls through to stage 2, and a stage-2 null is a block.
 */
export function parseSeverity(text: string): number | null {
	const tags = [...text.matchAll(/<severity>([^<]*)/gi)];
	const last = tags.at(-1);
	if (!last) return null;
	const body = /^\s*(\d{1,3})\s*$/.exec(last[1]);
	if (!body) return null;
	return Math.min(100, Number.parseInt(body[1], 10));
}

/** The content of the last `<tag>…</tag>` (or `<tag>…` unterminated), trimmed. */
function parseTag(text: string, tag: string): string | undefined {
	const closed = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi"))];
	const raw = closed.length > 0 ? closed[closed.length - 1][1] : text.match(new RegExp(`<${tag}>([\\s\\S]*)`, "i"))?.[1];
	const trimmed = raw?.trim();
	return trimmed ? trimmed : undefined;
}

/** The threshold: below is allow, at/above is block (CC's Output Format). */
export const SEVERITY_THRESHOLD = 50;

/**
 * Each stage's output budget, and the budget of its one retry after a reply
 * cut off at the first. A model that cannot turn thinking off gets
 * classifier.ts FORCED_THINKING_PADDING on top of both.
 */
export const STAGE1_MAX_TOKENS = 64;
export const STAGE1_RETRY_MAX_TOKENS = 1024;
export const STAGE2_MAX_TOKENS = 4096;
export const STAGE2_RETRY_MAX_TOKENS = 8192;

/**
 * Parse a completed stage-2 reply and ground it. severity < 50 ⇒ allow, on the
 * classifier's judgment as in Claude Code; severity ≥ 50 ⇒ block, with the tier
 * derived from the grounded category rather than from anything the model
 * asserted. An unparseable severity, or a block citing a category that is not a
 * real rule, is still a block but tagged so it cannot borrow a real HARD rule's
 * authority.
 */
export function parseStage2(text: string, index: RuleIndex): ClassifyVerdict {
	const severity = parseSeverity(text);
	const raw = clip(text.replace(/\s+/g, " ").trim(), 300) || undefined;
	if (severity === null) {
		return {
			decision: "block",
			reason: autoModeResultText.classifierBlock({ kind: "noSeverity" }),
			tier: "unmatched",
			raw,
			noVerdict: true,
		};
	}

	if (severity < SEVERITY_THRESHOLD) {
		// The cited category (an ALLOW exception, usually) is kept as the ruleId
		// for the log; a clear citing nothing is what the caller tags
		// `unverified-clear` when stage 1 had flagged the call.
		const cited = parseTag(text, "category");
		return { decision: "allow", reason: "", tier: "allow", ...(cited ? { ruleId: clip(cited, 80) } : {}) };
	}

	// severity >= 50 → block. Ground the cited category against the rule index.
	const category = parseTag(text, "category");
	const rule = groundCategory(index, category);
	if (!rule) {
		return {
			decision: "block",
			reason: autoModeResultText.classifierBlock({ kind: "unmatchedRule", ...(category ? { category } : {}) }),
			tier: "unmatched",
			ruleId: category,
			raw,
		};
	}
	return { decision: "block", reason: rule.name, tier: rule.tier, ruleId: rule.name, raw };
}

/** Convenience for callers that hold the ruleset text rather than a prebuilt index. */
export function indexFor(environment: string[], extras?: RuleExtras): RuleIndex {
	return buildCategoryIndex(buildRuleset(environment, extras));
}
