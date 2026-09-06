/**
 * Claude Code hook protocol (pure): the stdin payload shape, the stdout JSON
 * envelope, and the mapping from a finished hook run to what One Code should do
 * about it. Envelope semantics follow Claude Code's hooks reference; the
 * fail-closed choices are One Code's own (see docs/decisions.md).
 */

import { isAppendedReminderText } from "../lib/reminders.ts";

/** The contiguous run of reminder/countdown blocks at the tail of a tool result (review M3). */
function trailingReminderBlocks<T extends { type: string }>(content: readonly T[]): T[] {
	let start = content.length;
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i] as { type: string; text?: unknown };
		if (block.type === "text" && typeof block.text === "string" && isAppendedReminderText(block.text)) start = i;
		else break;
	}
	return content.slice(start);
}

export type CcHookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "SessionStart"
	| "Stop"
	| "SessionEnd"
	| "PreCompact"
	| "PostCompact";

export const CC_HOOK_EVENTS: readonly CcHookEvent[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"SessionStart",
	"Stop",
	"SessionEnd",
	"PreCompact",
	"PostCompact",
];

/** What a hook command reads from stdin — Claude Code's field names exactly. */
export interface HookStdinPayload {
	session_id: string;
	/** Empty string when the session has no file yet (e.g. --no-session). */
	transcript_path: string;
	cwd: string;
	hook_event_name: CcHookEvent;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: { content: unknown; is_error: boolean };
	prompt?: string;
	stop_hook_active?: boolean;
	trigger?: "manual" | "auto";
	/** PreCompact: the `/compact <instructions>` text, empty when none (Claude Code sends the string as is). */
	custom_instructions?: string;
	/** PostCompact: the summary that replaced the compacted span. */
	compact_summary?: string;
	source?: string;
	/** SessionEnd: why the session ended — clear | logout | prompt_input_exit | other (Claude Code's values). */
	reason?: string;
	/** Set when the call is a subagent's (Claude Code: hooks tell a child's call from the main thread's by its presence). */
	agent_id?: string;
	agent_type?: string;
}

export interface HookEnvelope {
	continue?: boolean;
	stopReason?: string;
	suppressOutput?: boolean;
	systemMessage?: string;
	/** Legacy top-level fields, still emitted by many hook scripts. */
	decision?: string;
	reason?: string;
	hookSpecificOutput?: {
		hookEventName?: string;
		permissionDecision?: string;
		permissionDecisionReason?: string;
		additionalContext?: string;
		updatedInput?: Record<string, unknown>;
		updatedToolResult?: unknown;
	};
}

/** Parse a hook's stdout as the JSON envelope; non-JSON stdout is not an error. */
export function parseEnvelope(stdout: string): HookEnvelope | undefined {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null ? (parsed as HookEnvelope) : undefined;
	} catch {
		return undefined;
	}
}

/** What one finished hook run asks One Code to do. */
export interface HookOutcome {
	block?: { reason: string };
	updatedInput?: Record<string, unknown>;
	updatedToolResult?: unknown;
	additionalContext?: string;
	systemMessage?: string;
}

export interface FinishedRun {
	exitCode: number | null;
	timedOut: boolean;
	spawnError?: string;
	stdout: string;
	stderr: string;
}

/** Events where a hung or killed hook must fail closed rather than open. */
const TIMEOUT_BLOCKS: ReadonlySet<CcHookEvent> = new Set(["PreToolUse", "UserPromptSubmit"]);
/**
 * Events where CC's plain (non-JSON) stdout becomes model-visible context
 * rather than being discarded.
 */
const STDOUT_IS_CONTEXT: ReadonlySet<CcHookEvent> = new Set(["UserPromptSubmit", "SessionStart"]);

export function interpretHookResult(event: CcHookEvent, run: FinishedRun): HookOutcome {
	// Killed (timeout or otherwise): a null exit code must never read as a
	// clean allow. Closed for the two events that gate something; open for the
	// rest — the side effect already happened, or blocking would wedge exit.
	if (run.timedOut || (run.exitCode === null && !run.spawnError)) {
		return TIMEOUT_BLOCKS.has(event) ? { block: { reason: "Hook timed out" } } : {};
	}
	// A hook that couldn't spawn at all is an environment problem, not a
	// verdict — fail open everywhere (CC treats non-2 errors as non-blocking).
	if (run.spawnError) return {};

	if (run.exitCode === 2) {
		return { block: { reason: run.stderr.trim() || "Hook blocked the action (exit 2)" } };
	}
	if (run.exitCode !== 0) return {};

	const envelope = parseEnvelope(run.stdout);
	if (!envelope) {
		const text = run.stdout.trim();
		return text && STDOUT_IS_CONTEXT.has(event) ? { additionalContext: text } : {};
	}

	const outcome: HookOutcome = {};
	const specific = envelope.hookSpecificOutput;

	if (envelope.continue === false) {
		outcome.block = { reason: envelope.stopReason?.trim() || "Hook stopped continuation" };
	}
	const decision = specific?.permissionDecision;
	if (decision === "deny" || decision === "ask") {
		// pi's tool_call is allow-or-block; treating "ask" as a silent allow
		// would be the unsafe reading, so it blocks with the hook's reason.
		outcome.block ??= {
			reason:
				specific?.permissionDecisionReason?.trim() ||
				(decision === "ask" ? "Hook requested user confirmation" : "Hook denied the action"),
		};
	}
	if (envelope.decision === "block") {
		outcome.block ??= { reason: envelope.reason?.trim() || "Hook blocked the action" };
	}
	// "allow" is deliberately not handled: a hook cannot pre-approve anything —
	// One Code's permission gate, safety floor, and classifier still run.

	if (specific?.updatedInput && typeof specific.updatedInput === "object") {
		outcome.updatedInput = specific.updatedInput;
	}
	if (specific && "updatedToolResult" in specific) outcome.updatedToolResult = specific.updatedToolResult;
	if (specific?.additionalContext?.trim()) outcome.additionalContext = specific.additionalContext.trim();
	if (envelope.systemMessage?.trim()) outcome.systemMessage = envelope.systemMessage.trim();
	return outcome;
}

/** A text block as pi's tool results carry it; what PostToolUse assembly adds. */
interface TextBlock {
	type: "text";
	text: string;
}

/**
 * A tool result's content after PostToolUse hooks spoke, or undefined when no
 * hook changed anything. Shared by the parent's `tool_result` handler and the
 * child hook gate so a subagent's results are assembled exactly like the
 * parent's: an `updatedToolResult` replaces the content (a non-string is
 * JSON-encoded), a block's reason is put in front — the tool already ran, so
 * the objection is delivered in the result the model reads, the error flag left
 * as the tool set it (a successful write marked as an error invites a redo) —
 * and `additionalContext` (already framed by the caller) goes behind.
 */
export function applyPostToolUseOutcome<T extends { type: string }>(
	content: readonly T[],
	outcome: Pick<HookOutcome, "block" | "updatedToolResult" | "additionalContext">,
): Array<T | TextBlock> | undefined {
	if (!outcome.block && outcome.updatedToolResult === undefined && !outcome.additionalContext) return undefined;
	let result: Array<T | TextBlock> = [...content];
	if (outcome.updatedToolResult !== undefined) {
		const replacement = outcome.updatedToolResult;
		// The reminder queue may already have appended one-shots and the
		// `<total_tokens>` countdown onto this result (system-reminder runs its
		// tool_result hook before ours). Replacing the content must not drop
		// them, so keep the trailing run of reminder blocks (review M3).
		const reminderTail = trailingReminderBlocks(content);
		result = [{ type: "text", text: typeof replacement === "string" ? replacement : JSON.stringify(replacement) }, ...reminderTail];
	}
	if (outcome.block) result = [{ type: "text", text: `PostToolUse hook: ${outcome.block.reason}` }, ...result];
	if (outcome.additionalContext) result = [...result, { type: "text", text: outcome.additionalContext }];
	return result;
}
