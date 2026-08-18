/**
 * The parent→child permission bridge.
 *
 * In-process subagent sessions get a `noExtensions` loader, so the real
 * `permissions` extension never loads inside them. To match Claude Code — where a
 * subagent's tool calls go through the *same* permission pipeline as the main
 * agent (mode inheritance, the auto-mode classifier, and interactive prompts that
 * bubble to the user; findings §17.1) — the parent's `permissions` extension
 * publishes a decision closure on this channel. `subagents` captures it and
 * threads it into the child runner, whose `permission-gate` calls it for every
 * child tool call instead of its fail-closed local fallback.
 *
 * The closure is invoked in-process from the child's `tool_call` handler; it runs
 * against the parent's live mode/rules/ctx (so a prompt renders on the parent's
 * terminal). A plain function over `pi.events` is the only transport that works:
 * each child session has its own EventBus, so `pi.events` does not cross the
 * boundary — but the parent's `subagents` and `permissions` extensions share one,
 * and the closure is carried the rest of the way as an ordinary reference (the
 * same shape as `MCP_TOOLS_CHANNEL` sharing tool definitions).
 */

export const SUBAGENT_GATE_CHANNEL = "one-code:subagent-permission-gate";

/** One child tool call to evaluate. `cwd` is the child's runtime cwd (a worktree, if isolated). */
export interface ChildToolCall {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	/** The child's live turn signal, so a classifier call is aborted when the child turn is. */
	signal?: AbortSignal;
}

/** A permission decision: `undefined` = allow; otherwise block with a model-facing reason. */
export type ChildGateDecision = { block: true; reason: string } | undefined;

/** The parent's decision closure, threaded into a child's permission gate. */
export type PermissionBridge = (call: ChildToolCall) => Promise<ChildGateDecision>;

export interface SubagentGatePayload {
	decide: PermissionBridge;
}

/**
 * Subscribe to the gate channel and return a lazy getter for the latest bridge.
 * Call once from an extension entry point (only they hold a `pi`); the getter is
 * what gets threaded into child runners, and yields `undefined` until the
 * permissions extension publishes at session start.
 */
export function watchPermissionBridge(pi: {
	events: { on(channel: string, handler: (data: unknown) => void): void };
}): () => PermissionBridge | undefined {
	let bridge: PermissionBridge | undefined;
	pi.events.on(SUBAGENT_GATE_CHANNEL, (data) => {
		bridge = (data as SubagentGatePayload | undefined)?.decide;
	});
	return () => bridge;
}
