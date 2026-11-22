/**
 * The provider's limit on a tool name (pure).
 *
 * A provider rejects the whole request when one tool name is over its limit,
 * and a loaded tool rides every later request, so one over-long name breaks
 * every later turn. The limit belongs to the request's model, which can change
 * mid-session: an MCP server registers its tools up to the widest limit
 * (`WIDEST_TOOL_NAME_LENGTH`), and the deferral reconciler keeps a tool whose
 * name the current model's provider refuses out of the active set, the
 * listing and `tool_search` (request/tool-search); an up-front tool it took
 * out comes back at the switch to a model that takes it (`limitWithdrawals`).
 * A model switch opens a ledger epoch, so the tools array changes there and
 * only there. Names are
 * never shortened or hashed: a user's `mcp__…` permission rules and hook
 * matchers match the name.
 */

import { wireShape } from "./system-role.ts";

/** The longest tool name any provider One Code talks to accepts (Anthropic's and Gemini's limit). */
export const WIDEST_TOOL_NAME_LENGTH = 128;

/**
 * The longest tool name the provider behind `api` accepts: 64 on the OpenAI
 * family (OpenAI documents the limit for `function.name`; the family is the
 * Responses and Completions wire shapes, `wireShape`), the widest limit
 * elsewhere and while the API is unknown.
 */
export function maxToolNameLength(api: string | undefined): number {
	const shape = api === undefined ? undefined : wireShape(api);
	return shape === "responses" || shape === "completions" ? 64 : WIDEST_TOOL_NAME_LENGTH;
}

/** The names in `names` the provider behind `api` refuses, in their order. */
export function namesOverLimit(names: Iterable<string>, api: string | undefined): string[] {
	const max = maxToolNameLength(api);
	return [...names].filter((name) => name.length > max);
}

/** The `one-code:state` key that holds the tools the name limit took out of the active set (`limitWithdrawals`). */
export const LIMIT_WITHDRAWN_STATE = "tool-search:limit-withdrawn";

/** What `limitWithdrawals` reads: the reconciler's view of one pass. */
export interface LimitWithdrawalInput {
	/** pi's active set before the pass. */
	active: readonly string[];
	/** What the branch recorded as withdrawn by the limit (the latest `LIMIT_WITHDRAWN_STATE`). */
	recorded: readonly string[];
	/** Whether the pass's model refuses the name. */
	refused: (name: string) => boolean;
	/** Whether the tool is kept out for a reason other than the limit (a withhold, the profile). */
	blocked: (name: string) => boolean;
	/** Whether the reconciler's deferral decides the tool (it is deferred): its own reasons bring it back. */
	deferred: (name: string) => boolean;
	registered: ReadonlySet<string>;
}

/**
 * The up-front tools the name limit takes out of the active set and brings
 * back. A tool is withdrawn when it is active and the model refuses its name
 * only for that reason; it is restored at the first pass whose model takes the
 * name, when it is registered, not blocked and not active. That pass consumes
 * the record either way, so a tool never comes back later inside the epoch the
 * switch opened. A refused tool is never active, so nothing else can have
 * removed it while it was withdrawn; the record follows the branch, so a
 * `/tree` switch to a branch from before the withdrawal has none.
 * `record` is the next value to store (in the order the tools left).
 */
export function limitWithdrawals(input: LimitWithdrawalInput): { restore: string[]; record: string[] } {
	const { active, recorded, refused, blocked, deferred, registered } = input;
	const upFront = (name: string) => !blocked(name) && !deferred(name);
	const withdrawn = active.filter((name) => refused(name) && upFront(name));
	const restore = recorded.filter((name) => !refused(name) && upFront(name) && registered.has(name) && !active.includes(name));
	return { restore: [...new Set(restore)], record: [...new Set([...recorded.filter(refused), ...withdrawn])] };
}
