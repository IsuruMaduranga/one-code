/**
 * MCP failures as data (text.ts McpFailure): thrown inside the client so the
 * profile words them where they are shown (the failed-servers block, /mcp).
 * The message is a code for logs, never shown to the model.
 */

import type { McpFailure, StderrTail } from "./text.ts";

export class McpFailureError extends Error {
	constructor(readonly failure: McpFailure) {
		super(`MCP failure: ${failure.kind}`);
		this.name = "McpFailureError";
	}
}

/** The failure an error carries, or the error's own message. */
export function failureOf(error: unknown): McpFailure {
	if (error instanceof McpFailureError) return error.failure;
	return { kind: "error", osMessage: error instanceof Error ? error.message : String(error) };
}

/** The last 1,000 characters of a server's stderr tail, or undefined when it wrote nothing. */
export function shownStderr(tail: string): StderrTail | undefined {
	if (!tail) return undefined;
	return tail.length > 1_000 ? { text: tail.slice(-1_000), cut: true } : { text: tail, cut: false };
}
