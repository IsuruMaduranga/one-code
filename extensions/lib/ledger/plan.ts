/**
 * One request's plan, shared over `pi.events` by the three parts of the
 * request path (design.md section 5): the ledger's `context` hook decides it,
 * the renderer (system-reminder) fills in what the request carries, and the
 * ledger's payload hook splices, validates and records by it.
 *
 * The plan object is created once per `context` pass and passed by reference,
 * so the renderer's additions reach the payload hook. A pi cache warm or a
 * provider retry re-runs only the payload hooks; they reuse the last plan.
 *
 * Pure: no pi imports.
 */
import type { FoldedRequest, LedgerFold } from "./fold.ts";
import type { Coverage, EpochCause, ToldFact } from "./records.ts";

/** Published by the ledger's `context` hook, once per request. */
export const LEDGER_PLAN_CHANNEL = "one-code:ledger-plan";

/**
 * Published by the ledger's payload hook with the request as it goes out
 * (`LedgerSent`): the spliced, validated body, before cache-marks adds its
 * look-back mark. A pi cache warm publishes it again.
 */
export const LEDGER_SENT_CHANNEL = "one-code:ledger-sent";

export interface LedgerSent {
	payload: Record<string, unknown>;
	model: { api?: string; provider?: string; id?: string } | undefined;
	sessionId: string;
	plan: RequestPlan;
}

export interface RequestPlan {
	/** True when the request opens an epoch: the whole conversation goes through pi and the message-1 stack is rendered. */
	epoch: boolean;
	/** Why it opens one; the plan adds "coverage" (the base cannot be extended) and "empty" (nothing new since it) to the fold's causes. */
	cause?: EpochCause;
	/** The request this one extends inside its epoch; undefined on an epoch. */
	base?: FoldedRequest;
	/** The context messages this request covers, for its record. */
	covers: Coverage;
	/** The branch's fold at this request. */
	fold: LedgerFold;
	/** Pending ids this request carries (the renderer fills it). */
	consumed: string[];
	/** What this request's new blocks tell the model (the renderer fills it). */
	facts: ToldFact[];
	/** Each new block's text with the facts it carries, so a repair that drops a block drops its facts (the renderer fills it). */
	carried: CarriedFacts[];
	/** Every context message pi built for the request, before the cut: what the whole request covers. */
	messages: readonly CoveredMessage[];
}

/** A block's text and the facts it tells: they count only while the text is on the wire. */
export interface CarriedFacts {
	text: string;
	facts: readonly ToldFact[];
}

/** A context message as far as coverage reads it. */
export interface CoveredMessage {
	role: string;
	timestamp?: number;
}

/** The coverage of a request that sends `messages`. */
export function coverageOf(messages: readonly CoveredMessage[]): Coverage {
	const last = messages.at(-1);
	return { count: messages.length, role: last?.role ?? "", timestamp: last?.timestamp ?? 0 };
}

/**
 * The plan for a request over `messages` (pi's context messages, before any
 * extension injects into them), and the index where the tail this request
 * sends through pi starts: 0 when it opens an epoch. The base is extended only
 * when it covered a prefix of `messages` that is still there, ending in the
 * same message, and something came after it.
 */
export function planRequest(fold: LedgerFold, messages: readonly CoveredMessage[]): { plan: RequestPlan; tailStart: number } {
	const covers = coverageOf(messages);
	const plan = (epoch: boolean, cause: EpochCause | undefined, base?: FoldedRequest): RequestPlan => ({
		epoch,
		...(cause ? { cause } : {}),
		...(base ? { base } : {}),
		covers,
		fold,
		consumed: [],
		facts: [],
		carried: [],
		messages,
	});
	const base = fold.lastRequest;
	if (fold.opensEpoch || !base) return { plan: plan(true, fold.cause ?? "first"), tailStart: 0 };
	const at = base.covers;
	const last = at && at.count > 0 ? messages[at.count - 1] : undefined;
	if (!at || at.count > messages.length || (at.count > 0 && (last?.role !== at.role || (last?.timestamp ?? 0) !== at.timestamp))) {
		return { plan: plan(true, "coverage"), tailStart: 0 };
	}
	if (at.count === messages.length) return { plan: plan(true, "empty"), tailStart: 0 };
	return { plan: plan(false, undefined, base), tailStart: at.count };
}
