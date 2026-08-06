/**
 * Claude Code hook protocol (pure): the stdin payload shape, the stdout JSON
 * envelope, and the mapping from a finished hook run to what pincer should do
 * about it. Envelope semantics follow Claude Code's hooks reference; the
 * fail-closed choices are pincer's own (see docs/decisions.md).
 */

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
	source?: string;
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

/** What one finished hook run asks pincer to do. */
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
	// pincer's permission gate, safety floor, and classifier still run.

	if (specific?.updatedInput && typeof specific.updatedInput === "object") {
		outcome.updatedInput = specific.updatedInput;
	}
	if (specific && "updatedToolResult" in specific) outcome.updatedToolResult = specific.updatedToolResult;
	if (specific?.additionalContext?.trim()) outcome.additionalContext = specific.additionalContext.trim();
	if (envelope.systemMessage?.trim()) outcome.systemMessage = envelope.systemMessage.trim();
	return outcome;
}
