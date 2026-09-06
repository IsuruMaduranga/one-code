/**
 * Classifier payload assembly and stage-verdict parsing (pure).
 *
 * The payload is Claude Code's shape (docs/decisions/auto-mode.md, P4/P5):
 *   system = <ruleset with Environment spliced> + <Session Context>
 *   user   = <CLAUDE.md framing> + <transcript> + <stage final instruction>
 * The two stages share system+framing+transcript byte-for-byte and differ only
 * in the final instruction block, so stage 2 is a cache hit off stage 1.
 *
 * Kept free of any pi/network import so the exact text sent, and the parsing of
 * what comes back, are unit-testable.
 */

import {
	buildRuleset,
	claudeMdFraming,
	renderSessionContext,
	type RuleExtras,
	STAGE1_FINAL,
	STAGE2_FINAL,
	STAGE2_INTENT_ADDENDUM,
} from "./classifier-prompt.ts";
import { buildCategoryIndex, groundCategory, normalizeName, type RuleIndex } from "./rules.ts";
import { clip, renderTranscript, type TranscriptEntry } from "./transcript.ts";

export interface ClassifyRequest {
	/**
	 * The ordered transcript, user messages and tool inputs only (results
	 * stripped). Its **last entry is the action under review** — the caller
	 * appends the call being judged before handing it here.
	 */
	transcript: TranscriptEntry[];
	/**
	 * Every user message this session, for intent-quote verification. Full, never
	 * a rolling window: in a long unattended run the authorizing setup message
	 * must still clear a later action (decision 2). Distinct from the transcript,
	 * whose oldest lines may be dropped for length.
	 */
	userMessages: string[];
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
	tier?: "hard_deny" | "soft_deny" | "allow" | "intent" | "unmatched" | "timeout";
	/** The grounded rule name (or a sentinel like `intent-unverified`). */
	ruleId?: string;
	/** The model's own wording, kept for diagnosis and shown attributed to it. */
	raw?: string;
}

/**
 * Build the shared payload plus the grounding index. The ruleset (~110 KB) is
 * built once here and used for both the system prompt and the category index, so
 * `classify()` does not rebuild and re-parse it a second time per call. The final
 * instruction is appended per stage by the caller (stage1User / stage2User).
 */
export function buildPayload(request: ClassifyRequest): { system: string; userPrefix: string; index: RuleIndex } {
	const ruleset = buildRuleset(request.environment, request.ruleExtras);
	const system = ruleset + renderSessionContext(request.username);
	const framing = claudeMdFraming(request.claudeMd);
	const transcript = renderTranscript(request.transcript);
	const userPrefix = [framing, transcript].filter(Boolean).join("\n\n");
	return { system, userPrefix, index: buildCategoryIndex(ruleset) };
}

/** The stage-1 user message: shared prefix + the harm-only final instruction. */
export function stage1User(userPrefix: string): string {
	return `${userPrefix}\n\n${STAGE1_FINAL.trimStart()}`;
}

/**
 * Ours — appended to STAGE2_FINAL only when the transcript carries a
 * `denied_by_permission_rule` line. Stage 2's job is to weigh user intent, and
 * that is exactly what let a retry through: after `Bash(rm:*)` refused
 * `rm scripts/slow_build.sh`, `python3 -c "import os; os.remove(…)"` was cleared
 * on the user's own "Delete scripts/slow_build.sh" (WEAK-MODEL-REVIEW-2026-09-06
 * H2). A permission rule is the user's decision made in advance, so it outranks
 * the intent stage rather than being excused by it. One-directional, like the
 * intent addendum: it can only turn an allow into a block.
 */
export const STAGE2_DENIAL_ADDENDUM =
	"\n\nAdditionally: the transcript contains one or more `denied_by_permission_rule` entries — actions the user's own " +
	"permission rules already refused. Those rules are the user's decision about a CLASS of action, made in advance, and " +
	"user intent does NOT override them. If the action under review would achieve the effect of a denied action by another " +
	"route (a different command, a script, an interpreter one-liner, another tool), treat it as a circumvention of the " +
	"user's rules and BLOCK it, however plainly the user asked for the underlying goal.";

/**
 * The stage-2 user message: shared prefix + full-eval final + our intent
 * addendum, plus the denial addendum when the transcript holds a rule denial.
 */
export function stage2User(userPrefix: string, afterRuleDenial = false): string {
	return `${userPrefix}\n\n${STAGE2_FINAL.trimStart()}${STAGE2_INTENT_ADDENDUM}${afterRuleDenial ? STAGE2_DENIAL_ADDENDUM : ""}`;
}

/**
 * Ours — reframes stage 2 for the completed-run subagent review. CC's final block
 * tells the model to judge "the most recent action"; a retrospective sequence
 * review needs it to weigh the whole finished run instead (a series of
 * individually unremarkable steps can add up to a violation). Restores the
 * framing the pre-two-stage `routedBecause` carried.
 */
export const STAGE_REVIEW_ADDENDUM =
	"\n\nNote: this is a RETROSPECTIVE review of a delegated subagent run that has ALREADY completed — " +
	"the transcript's trailing entries are the subagent's actions (summarized). You are not approving a " +
	"pending action; judge the sequence of those actions AS A WHOLE and flag whether, together, they did " +
	"something the rules forbid — not only the final entry.";

/** The completed-run review message: shared prefix + full-eval final + review reframing. */
export function reviewUser(userPrefix: string): string {
	return `${userPrefix}\n\n${STAGE2_FINAL.trimStart()}${STAGE_REVIEW_ADDENDUM}`;
}

/** The integer inside the last `<severity>…` tag (closing tag optional). */
export function parseSeverity(text: string): number | null {
	const matches = [...text.matchAll(/<severity>\s*(\d{1,3})/gi)];
	if (matches.length === 0) return null;
	const value = Number.parseInt(matches[matches.length - 1][1], 10);
	if (Number.isNaN(value)) return null;
	return Math.max(0, Math.min(100, value));
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

/** A quote shorter than this proves nothing — a stray word matches any transcript. */
const INTENT_MIN_CHARS = 8;

/**
 * Strip what a model adds around a verbatim quote without changing its words:
 * wrapping quotation marks (straight, typographic, backticks, any nesting —
 * the runs are greedy), sentence punctuation left outside the closing quote
 * (`"…".`), and leading or trailing ellipses marking a truncated quote. Then
 * normalizeName folds case, whitespace runs and trailing sentence punctuation.
 * Exported for tests.
 */
export function normalizeQuote(value: string): string {
	const text = value
		.replace(/^[\s"'`\u201c\u201d\u2018\u2019\u00ab\u00bb]+/, "")
		.replace(/["'`\u201c\u201d\u2018\u2019\u00ab\u00bb\s.,:;]+$/, "")
		.replace(/^(\u2026|\.{3,})\s*/, "")
		.replace(/\s*(\u2026|\.{3,})$/, "");
	return normalizeName(text);
}

/**
 * Whether the classifier's `<intent>` quote is really the user's words. The
 * whole quote (after normalizeQuote) must be a substring of one user message;
 * failing that, a multi-line quote passes when every line of at least
 * INTENT_MIN_CHARS is itself a substring — a model quoting two sentences from
 * one message often joins them with a newline the original never had. Live
 * probes (2026-09-05, Haiku twice) returned `<intent>"…"</intent>` for a quote
 * that was verbatim; the bare substring test rejected it and a legitimate allow
 * became a soft block — the failure the auto-mode entry says gets auto mode
 * switched off. Still one-directional: nothing here can turn a block into an
 * allow that the words themselves do not support.
 */
export function intentQuoted(intent: string, userMessages: string[]): boolean {
	const messages = userMessages.map((message) => normalizeName(message));
	const whole = normalizeQuote(intent);
	if (whole.length >= INTENT_MIN_CHARS && messages.some((message) => message.includes(whole))) return true;
	const lines = intent
		.split(/\r?\n/)
		.map((line) => normalizeQuote(line))
		.filter((line) => line.length > 0);
	if (lines.length < 2 || lines.some((line) => line.length < INTENT_MIN_CHARS)) return false;
	// Every line must come from the SAME message, IN ORDER: two authorizations
	// from different turns stitched together are not one statement of intent,
	// and neither is a later clause pasted in front of an earlier one ("edit
	// config.yaml" + "touch secrets.yaml" lifted out of "under no circumstances
	// touch secrets.yaml" must not verify because each is a substring somewhere).
	return messages.some((message) => {
		let cursor = 0;
		for (const line of lines) {
			const at = message.indexOf(line, cursor);
			if (at < 0) return false;
			cursor = at + line.length;
		}
		return true;
	});
}

/**
 * Parse a completed stage-2 reply and ground it. severity < 50 ⇒ allow (with the
 * one-directional intent-quote check when the model credits user intent);
 * severity ≥ 50 ⇒ block, with the tier derived from the grounded category rather
 * than from anything the model asserted. An unparseable severity, or a block
 * citing a category that is not a real rule, is still a block but tagged so it
 * cannot borrow a real HARD rule's authority.
 */
export function parseStage2(text: string, index: RuleIndex, userMessages: string[] = []): ClassifyVerdict {
	const severity = parseSeverity(text);
	const raw = clip(text.replace(/\s+/g, " ").trim(), 300) || undefined;
	if (severity === null) {
		return {
			decision: "block",
			reason: "The approval classifier's reply carried no severity, so the verdict could not be read.",
			tier: "unmatched",
			raw,
		};
	}

	if (severity < SEVERITY_THRESHOLD) {
		const intent = parseTag(text, "intent");
		if (intent) {
			// An allow resting on user intent is the one claim worth checking: it is
			// what a prompt injection most wants to manufacture and what the model is
			// most prone to stretch. Verified against the full user messages, so an
			// early authorization still clears late (decision 2).
			if (!intentQuoted(intent, userMessages)) {
				return {
					decision: "block",
					reason:
						"The classifier cleared this as something the user asked for, but could not point to the user's own words asking for it.",
					tier: "soft_deny",
					ruleId: "intent-unverified",
					// The full quote, not a clip: the mismatch class is only diagnosable
					// from the exact text the model produced (2026-09-05 H4).
					raw: intent,
				};
			}
			return { decision: "allow", reason: "", tier: "intent" };
		}
		// A plain clear. The cited category (an ALLOW exception, usually) is kept
		// as the ruleId for the log; a clear citing nothing is what the caller tags
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
			reason: category
				? `The approval classifier blocked this as "${category}", which is not a rule that could be matched.`
				: "The approval classifier blocked this without naming a rule.",
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
