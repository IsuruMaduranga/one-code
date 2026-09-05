/**
 * The parent→child hook bridge.
 *
 * In-process subagent sessions get a `noExtensions` loader, so the `hooks`
 * extension never loads inside them, and until 2026-09-05 a user's
 * PreToolUse/PostToolUse hooks — the Claude Code-compatible way to block a
 * command class, rewrite inputs, run a formatter, inject context — applied to
 * the main model's tool calls and to nothing a child did
 * (STEERING-REVIEW-2026-09-05 M4). Claude Code runs hooks inside subagents
 * (`tools/AgentTool/runAgent.ts` passes the same `canUseTool` pipeline; hook
 * payloads carry `agent_id`/`agent_type`).
 *
 * Same transport as the permission bridge (`permissions/subagent-gate.ts`):
 * the parent's `hooks` extension publishes a closure pair on this channel, the
 * spawning extension captures it and threads it into the child loader, whose
 * `hook-gate` inline extension calls it from the child's `tool_call` and
 * `tool_result` handlers. Dispatch happens parent-side — the hook settings,
 * project-hook consent, debug logging and the trust store stay in one place —
 * with the payload naming the child (its session id as `agent_id`, the agent
 * type, its cwd). Only the tool hooks are bridged: UserPromptSubmit, Stop,
 * SessionStart/End and the compaction hooks are main-conversation events
 * (Claude Code fires SubagentStop for a child's end, which One Code does not
 * implement yet).
 */

import { type BridgeWatchApi, watchBridge } from "../lib/bridge-watch.ts";

export const SUBAGENT_HOOK_CHANNEL = "one-code:subagent-hook-bridge";

/** One child tool call, as the child's `tool_call` handler sees it. */
export interface ChildHookCall {
	toolName: string;
	input: Record<string, unknown>;
	/** The child's runtime cwd (a worktree, if isolated). */
	cwd: string;
	/** The child session's id — becomes the payload's `session_id` and `agent_id`. */
	sessionId?: string;
	/** The child's session file, if persisted (payload `transcript_path`). */
	transcriptPath?: string;
	/** The agent type (`explore`, `general-purpose`, …), set by the runner; undefined for a fork. */
	agentType?: string;
}

/** The child's tool result, for PostToolUse. */
export interface ChildHookResult extends ChildHookCall {
	content: unknown;
	isError: boolean;
}

/** What the parent's PreToolUse hooks decided; fields absent when no hook spoke. */
export interface ChildPreToolUseOutcome {
	block?: { reason: string };
	/** Already translated back to the tool's native parameter names. */
	updatedInput?: Record<string, unknown>;
	additionalContext?: string;
}

/** What the parent's PostToolUse hooks decided. */
export interface ChildPostToolUseOutcome {
	block?: { reason: string };
	updatedToolResult?: unknown;
	additionalContext?: string;
}

export interface HookBridge {
	preToolUse(call: ChildHookCall): Promise<ChildPreToolUseOutcome>;
	postToolUse(result: ChildHookResult): Promise<ChildPostToolUseOutcome>;
}

export interface SubagentHookPayload {
	bridge: HookBridge;
}

/** A lazy getter for the latest published hook bridge (`lib/bridge-watch.ts`); undefined until the hooks extension publishes. */
export function watchHookBridge(pi: BridgeWatchApi): () => HookBridge | undefined {
	return watchBridge(pi, SUBAGENT_HOOK_CHANNEL, (data) => (data as SubagentHookPayload | undefined)?.bridge);
}
