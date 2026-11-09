/**
 * The child-only `send_message` tool, injected as a custom tool into an
 * in-process subagent session. From inside a subagent, `to: "main"` reports
 * progress/findings/questions to the main conversation mid-run — the subagent's
 * plain text output is not visible to the main conversation until it finishes.
 *
 * In-process this needs no IPC or event-stream parsing (unlike the spawned RPC
 * child, where the parent re-parsed the child's tool_execution_end): the tool's
 * execute() calls the parent's `onMessage` callback directly. The main
 * conversation's own `send_message`/`SendMessage` tool (agent→agent addressing)
 * is a different tool registered on the parent session.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { subagentWords } from "./words.ts";

export function sendToMainTool(onMessage: (message: string, summary?: string) => void): ToolDefinition {
	const words = subagentWords();
	const text = words.toMain;
	return {
		name: "SendMessage",
		label: "Send Message",
		description: text.description,
		parameters: Type.Object({
			to: Type.Optional(Type.String({ description: text.params.to })),
			message: Type.String({ description: text.params.message }),
			summary: Type.Optional(Type.String({ description: text.params.summary })),
		}) as never,
		async execute(_toolCallId: string, params: unknown) {
			const p = (params ?? {}) as { to?: unknown; message?: unknown; summary?: unknown };
			// Fail loud (working-docs/decisions/tools.md): a wrong recipient or a missing
			// message returns isError with the fix named, never a silent success.
			if (p.to !== undefined && p.to !== "main") {
				return {
					content: [{ type: "text" as const, text: words.refused({ kind: "onlyMain", got: JSON.stringify(p.to) }) }],
					details: {},
					isError: true,
				};
			}
			const message = typeof p.message === "string" ? p.message.trim() : "";
			if (!message) {
				return {
					content: [{ type: "text" as const, text: words.refused({ kind: "messageRequired" }) }],
					details: {},
					isError: true,
				};
			}
			const summary = typeof p.summary === "string" ? p.summary : undefined;
			onMessage(message, summary);
			return {
				content: [{ type: "text" as const, text: text.delivered }],
				details: { toMain: true, message, summary },
			};
		},
	} as ToolDefinition;
}
