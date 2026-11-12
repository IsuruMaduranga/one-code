/**
 * The hooks extension's words for the model, the way Claude Code words
 * them: the `hook_additional_context` line, the framing of a hook's block
 * on a tool call, a tool result and a Stop, the default reasons for a
 * verdict that gave none, and the notice that a hook rewrote a file the
 * model just wrote. The extension decides what a hook's verdict means. The
 * hook's own text (its reason, its added context, a replacement result)
 * passes through as the hook wrote it, under the base's cap. Notices for the
 * user (a blocked prompt, a cancelled compaction, the Stop continuation
 * limit) are in the extension.
 */

import type { CcHookEvent, HookBlock } from "../../lib/rules/hook-protocol.ts";

interface HooksText {
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

function blockReason(block: HookBlock): string {
	switch (block.kind) {
		case "stated":
			return block.reason;
		case "cancelled":
			return "Hook cancelled";
		case "timedOut":
			return "Hook timed out";
		case "outputLimit":
			return `Hook exceeded its output limit; reduce stdout/stderr to at most ${block.maxBytes.toLocaleString("en-US")} bytes per stream.`;
		case "exitTwo":
			return "Hook blocked the action (exit 2)";
		case "stopped":
			return "Hook stopped continuation";
		case "askRequested":
			return "Hook requested user confirmation";
		case "denied":
			return "Hook denied the action";
		case "blocked":
			return "Hook blocked the action";
	}
}

export const hooksText: HooksText = {
	additionalContext: ({ event, text }) => `${event} hook additional context: ${text}`,
	blockReason,
	preToolUseBlocked: ({ reason }) => `PreToolUse hook: ${reason}`,
	postToolUseBlocked: ({ reason }) => `PostToolUse hook: ${reason}`,
	stopBlocked: ({ reason }) => `Stop hook blocked stopping: ${reason}`,
	fileChangedByHook: ({ path }) =>
		`PostToolUse hook modified ${path} after your edit (likely a formatter). The change was intentional — do not revert it. Your next edit will not fail with a stale-file error, but if its old text targets a region the hook reformatted, read the file first, and read it before reporting the file's contents to the user.`,
};
