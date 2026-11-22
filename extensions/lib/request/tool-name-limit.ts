/**
 * The provider's limit on a tool name (pure).
 *
 * A provider rejects the whole request when one tool name is over its limit,
 * and a loaded tool rides every later request, so one over-long name breaks
 * every later turn. The limit belongs to the request's model, which can change
 * mid-session: an MCP server registers its tools up to the widest limit
 * (`WIDEST_TOOL_NAME_LENGTH`), and the deferral reconciler keeps a tool whose
 * name the current model's provider refuses out of the active set, the
 * listing and `tool_search` (request/tool-search). A model switch opens a
 * ledger epoch, so the tools array changes there and only there. Names are
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
