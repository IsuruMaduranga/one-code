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

/**
 * A server's error answer to a request: the JSON-RPC `code` and `data` kept
 * beside its message (the message alone is often a bare "Internal error.",
 * with the detail in `data`). The message stays the server's, so a start
 * failure worded from it reads as before.
 */
export class LspResponseError extends Error {
	constructor(
		readonly method: string,
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "LspResponseError";
	}
}

/** What a server answered when it refused a request. */
export interface LspErrorDetail {
	method: string;
	code: number;
	message: string;
	data?: unknown;
}

/**
 * The server's error detail when `error` is its refusal of a request, else
 * undefined. Read by shape, not `instanceof`: pi gives each extension its own
 * copy of this module, so a product extension's class is not the one the
 * client threw.
 */
export function lspErrorDetail(error: unknown): LspErrorDetail | undefined {
	if (!(error instanceof Error) || error.name !== "LspResponseError") return undefined;
	const { method, code, data } = error as Partial<LspResponseError>;
	if (typeof code !== "number") return undefined;
	return { method: String(method), code, message: error.message, ...(data === undefined ? {} : { data }) };
}

/** The failure an error carries, or the error's own message. */
export function failureOf(error: unknown): LspFailure {
	if (error instanceof LspFailureError) return error.failure;
	return { kind: "error", osMessage: error instanceof Error ? error.message : String(error) };
}
