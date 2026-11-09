/**
 * Language-server failures as data (text.ts LspFailure): raised inside the
 * client so the profile words them where they are shown (the tool result,
 * the one-time notice, /lsp). The message is a code for logs.
 */

import type { LspFailure } from "./text.ts";

export class LspFailureError extends Error {
	constructor(readonly failure: LspFailure) {
		super(`LSP failure: ${failure.kind}`);
		this.name = "LspFailureError";
	}
}

/** The failure an error carries, or the error's own message. */
export function failureOf(error: unknown): LspFailure {
	if (error instanceof LspFailureError) return error.failure;
	return { kind: "error", osMessage: error instanceof Error ? error.message : String(error) };
}
