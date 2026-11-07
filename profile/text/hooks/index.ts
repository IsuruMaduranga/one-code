/**
 * One Code's hooks text (the profile's `text.hooks`): Claude Code's
 * `hook_additional_context` line, the framing of a hook's block on a tool
 * call, a tool result and a Stop, the default reasons for a verdict that gave
 * none, and the notice that a hook rewrote a file the model just wrote.
 */

import type { HookBlock } from "../../../extensions/hooks/protocol.ts";
import type { HooksText } from "../../../extensions/hooks/text.ts";

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

export const hooks: HooksText = {
	additionalContext: ({ event, text }) => `${event} hook additional context: ${text}`,
	blockReason,
	preToolUseBlocked: ({ reason }) => `PreToolUse hook: ${reason}`,
	postToolUseBlocked: ({ reason }) => `PostToolUse hook: ${reason}`,
	stopBlocked: ({ reason }) => `Stop hook blocked stopping: ${reason}`,
	fileChangedByHook: ({ path }) =>
		`PostToolUse hook modified ${path} after your edit (likely a formatter). The change was intentional — do not revert it. Your next edit will not fail with a stale-file error, but if its old text targets a region the hook reformatted, read the file first, and read it before reporting the file's contents to the user.`,
};
