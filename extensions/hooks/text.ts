/**
 * What the hooks extension needs from a profile (types only). The extension
 * decides what a hook's verdict means; the profile words what the model reads
 * of it (working-docs/features/profiles/). The hook's own text (its reason,
 * its added context, a replacement result) passes through as the hook wrote
 * it; the cap on it stays in the base. Notices for the user (a blocked
 * prompt, a cancelled compaction, the Stop continuation limit) stay in the
 * base too.
 */

import type { CcHookEvent, HookBlock } from "./protocol.ts";

export interface HooksText {
	/** A hook's added context as the model reads it; the caller wraps it in a system reminder. */
	additionalContext(p: { event: CcHookEvent; text: string }): string;
	/** Why a hook blocked: the hook's stated reason, or the default for a verdict that gave none. */
	blockReason(block: HookBlock): string;
	/** The result of a tool call a PreToolUse hook blocked; `reason` is `blockReason`'s text. */
	preToolUseBlocked(p: { reason: string }): string;
	/** The line put before a result a PostToolUse hook objected to (the tool already ran). */
	postToolUseBlocked(p: { reason: string }): string;
	/** The follow-up message that keeps the turn going when a Stop hook blocks it from ending. */
	stopBlocked(p: { reason: string }): string;
	/** The reminder after a PostToolUse hook changed a file the model just wrote or edited. */
	fileChangedByHook(p: { path: string }): string;
}
