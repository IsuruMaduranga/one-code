/**
 * Hook gate for in-process agent sessions (pure), shared by the subagent and
 * workflow runners — the child half of `hooks/subagent-bridge.ts`.
 *
 * A child session is built with `noExtensions: true`, so the `hooks` extension
 * never loads inside it. This inline extension forwards the child's
 * `tool_call` / `tool_result` to the parent's hooks extension over the bridge
 * and applies what comes back exactly as the parent applies it to its own
 * calls: a PreToolUse block denies the call with the hook's reason; an
 * updatedInput is applied IN PLACE so the guards after this one (worktree
 * isolation, the permission gate) judge the rewritten input, as Claude Code
 * does; PreToolUse context is queued on the child's reminder channel (the child
 * loads system-reminder), so it lands inside the tool result; PostToolUse
 * block/replacement/context are written into the result content.
 *
 * Fail OPEN, like the parent's own dispatch: hooks are the user's automation,
 * not the safety gate — a missing or throwing bridge leaves the call to the
 * permission gate behind it. (The permission bridge, by contrast, fails closed.)
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { applyPostToolUseOutcome } from "../hooks/protocol.ts";
import type { ChildHookCall, HookBridge } from "../hooks/subagent-bridge.ts";
import { REMINDER_CHANNEL } from "./reminders.ts";

/** Tools the runtime itself injects; never run hooks for them. */
const DEFAULT_INTERNAL_TOOLS = new Set(["structured_output"]);

export interface HookGateOptions {
	/** The child's agent type for the payload's `agent_type`, resolved per session id by the runner. */
	agentTypeOf?: (sessionId: string | undefined) => string | undefined;
	neverGate?: Set<string>;
}

export function hookGateFactory(getBridge: () => HookBridge | undefined, options: HookGateOptions = {}): InlineExtension {
	const neverGate = options.neverGate ?? DEFAULT_INTERNAL_TOOLS;
	return {
		name: "agent-hook-gate",
		hidden: true,
		factory: (pi) => {
			const describe = (toolName: string, input: unknown, ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } } | undefined, fallbackCwd: string): ChildHookCall => {
				const sessionId = ctx?.sessionManager?.getSessionId?.();
				return {
					toolName,
					input: (input ?? {}) as Record<string, unknown>,
					cwd: ctx?.cwd ?? fallbackCwd,
					sessionId,
					transcriptPath: ctx?.sessionManager?.getSessionFile?.() ?? undefined,
					agentType: options.agentTypeOf?.(sessionId),
				};
			};

			pi.on("tool_call", async (event, ctx) => {
				if (neverGate.has(event.toolName)) return undefined;
				try {
					const bridge = getBridge();
					if (!bridge) return undefined;
					const call = describe(event.toolName, event.input, ctx as never, process.cwd());
					const outcome = await bridge.preToolUse(call);
					if (outcome.block) return { block: true, reason: `PreToolUse hook: ${outcome.block.reason}` };
					if (outcome.updatedInput) Object.assign(event.input as Record<string, unknown>, outcome.updatedInput);
					if (outcome.additionalContext) pi.events.emit(REMINDER_CHANNEL, { text: outcome.additionalContext });
				} catch {
					// Fail open: a broken hook pipeline must never take the child's turn down.
				}
				return undefined;
			});

			pi.on("tool_result", async (event, ctx) => {
				if (neverGate.has(event.toolName)) return undefined;
				try {
					const bridge = getBridge();
					if (!bridge) return undefined;
					const outcome = await bridge.postToolUse({
						...describe(event.toolName, event.input, ctx as never, process.cwd()),
						content: event.content,
						isError: event.isError,
					});
					// Same assembly as the parent's tool_result handler; the parent already
					// framed additionalContext as a <system-reminder>.
					const content = applyPostToolUseOutcome(event.content, outcome);
					if (!content) return undefined;
					return { content, isError: event.isError };
				} catch {
					return undefined;
				}
			});
		},
	};
}
