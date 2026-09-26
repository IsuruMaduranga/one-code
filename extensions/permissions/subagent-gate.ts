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

import type { Api, Model } from "@earendil-works/pi-ai";
import { type BridgeWatchApi, watchBridge } from "../lib/bridge-watch.ts";

export const SUBAGENT_GATE_CHANNEL = "one-code:subagent-permission-gate";

/** One child tool call to evaluate. `cwd` is the child's runtime cwd (a worktree, if isolated). */
export interface ChildToolCall {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	/**
	 * The child's live turn signal: a classifier call is aborted when the child
	 * turn is, and a prompt bubbled to the user is dismissed (as a denial) when
	 * the child is stopped mid-prompt — otherwise a dead agent's dialog stays on
	 * screen and holds the prompt chain (SUBAGENT-REVIEW M5).
	 */
	signal?: AbortSignal;
	/** The child session's id (what the gate can see); the runner maps it to `agent`. */
	sessionId?: string;
	/**
	 * The child's own model (its session state, never the model's to write). The
	 * gate judges a child's call by this model's tier, not the parent's.
	 */
	model?: Model<Api>;
	/** The run name of the asking agent, for the prompt title — set by the runner, not the gate. */
	agent?: string;
}

/** A permission decision: `undefined` = allow; otherwise block with a model-facing reason. */
export type ChildGateDecision = { block: true; reason: string } | undefined;

/** The parent's decision closure, threaded into a child's permission gate. */
export type PermissionBridge = (call: ChildToolCall) => Promise<ChildGateDecision>;

export interface SubagentGatePayload {
	decide: PermissionBridge;
}

/** A lazy getter for the latest published permission bridge (`lib/bridge-watch.ts`); undefined until the permissions extension publishes. */
export function watchPermissionBridge(pi: BridgeWatchApi): () => PermissionBridge | undefined {
	return watchBridge(pi, SUBAGENT_GATE_CHANNEL, (data) => (data as SubagentGatePayload | undefined)?.decide);
}
