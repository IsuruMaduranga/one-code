/**
 * A request on a profile-declared language server's connection, from a
 * product's own extension (extensions/sdk/extension.ts): its tool asks the
 * server the base already runs for diagnostics, instead of starting a second
 * one. A leaf module: the channel and its helper, no language-server code.
 *
 * The language-server extension answers in the listener, synchronously
 * handing back the promise, the way the base's other request channels do
 * (pi dispatches event handlers synchronously). With the feature off, or in
 * a child session (which loads no language server), nothing listens and the
 * request is rejected with the reason.
 */

import { brandedId } from "../../lib/profile/brand.mjs";

export const LSP_REQUEST_CHANNEL = brandedId("lsp-request");

export interface LspRequest {
	/** The server's name in the profile (`Profile.languageServers`). */
	server: string;
	/** A file the server serves: it picks the project root, and so the server instance. */
	file: string;
	method: string;
	params?: unknown;
	timeoutMs?: number;
}

/** What the listener receives: the request and where to hand its answer. */
export interface LspRequestEvent extends LspRequest {
	reply(answer: Promise<unknown>): void;
}

/** Send `request` to the server and resolve with its result; rejects when no server can answer. */
export function lspRequest(events: { emit(channel: string, data: unknown): void }, request: LspRequest): Promise<unknown> {
	let answer: Promise<unknown> | undefined;
	events.emit(LSP_REQUEST_CHANNEL, { ...request, reply: (promise) => (answer = promise) } satisfies LspRequestEvent);
	return answer ?? Promise.reject(new Error("No language server can answer: the language-server feature is off, or this is a child session, which loads none."));
}
