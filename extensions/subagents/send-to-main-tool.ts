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

export function sendToMainTool(onMessage: (message: string, summary?: string) => void): ToolDefinition {
	return {
		name: "SendMessage",
		label: "Send Message",
		description:
			'Report progress, findings, or a question to the main conversation mid-run (to: "main"). Your plain text output is NOT visible to the main conversation until you finish, so use this to surface something before then.',
		parameters: Type.Object({
			to: Type.Optional(Type.String({ description: 'Recipient — only "main" is valid from inside a subagent' })),
			message: Type.String({ description: "Plain text message for the main conversation" }),
			summary: Type.Optional(Type.String({ description: "5-10 word preview shown in the UI" })),
		}) as never,
		async execute(_toolCallId: string, params: unknown) {
			const p = (params ?? {}) as { to?: unknown; message?: unknown; summary?: unknown };
			// Fail loud (docs/decisions/tools.md): a wrong recipient or a missing
			// message returns isError with the fix named, never a silent success.
			if (p.to !== undefined && p.to !== "main") {
				return {
					content: [{ type: "text" as const, text: `From inside a subagent the only recipient is "main" — got ${JSON.stringify(p.to)}. Omit \`to\` or pass "main".` }],
					details: {},
					isError: true,
				};
			}
			const message = typeof p.message === "string" ? p.message.trim() : "";
			if (!message) {
				return {
					content: [{ type: "text" as const, text: "`message` is required: pass the plain text to deliver to the main conversation." }],
					details: {},
					isError: true,
				};
			}
			const summary = typeof p.summary === "string" ? p.summary : undefined;
			onMessage(message, summary);
			return {
				content: [{ type: "text" as const, text: "Message delivered to the main conversation." }],
				details: { toMain: true, message, summary },
			};
		},
	} as ToolDefinition;
}
