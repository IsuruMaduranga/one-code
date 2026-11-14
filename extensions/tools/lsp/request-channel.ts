/**
 * A product's own extension (extensions/sdk/extension.ts) on a
 * profile-declared language server's connection: a request, so its tool asks
 * the server the base already runs instead of starting a second one, and a
 * report of files that changed on disk, so that server stops answering from
 * an old copy. A leaf module: the channels and their helpers, no
 * language-server code.
 *
 * The language-server extension answers in the listener, synchronously
 * handing back the promise, the way the base's other request channels do
 * (pi dispatches event handlers synchronously). With the feature off, or in
 * a child session (which loads no language server), nothing listens: a
 * request is rejected with the reason, a report resolves, since no server
 * holds a copy to update.
 */

import { brandedId } from "../../lib/profile/brand.mjs";

export const LSP_REQUEST_CHANNEL = brandedId("lsp-request");
export const LSP_FILES_CHANGED_CHANNEL = brandedId("lsp-files-changed");

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

/** One file that changed on disk outside the session's `edit` and `write` tools. */
export interface LspFileChange {
	/** Absolute, or relative to the session's directory. */
	path: string;
	/**
	 * What happened, when the caller knows. The disk decides whether the file
	 * is gone; `type` only tells a new file from a changed one, which some
	 * servers treat differently. Left out, a present file counts as changed.
	 */
	type?: "created" | "changed" | "deleted";
}

export interface LspFilesChanged {
	/** The server's name in the profile (`Profile.languageServers`). */
	server: string;
	/** Each file picks its project root, and so the server instance, as a request's `file` does. */
	changes: LspFileChange[];
}

/** What the listener receives: the report and where to hand its outcome. */
export interface LspFilesChangedEvent extends LspFilesChanged {
	reply(done: Promise<void>): void;
}

/**
 * Report files that changed on disk to the server that serves them. A file
 * the server holds open is re-sent from disk (or closed when deleted); any
 * other file is announced as a watched-file event, so the server reads it
 * from disk. A server that is not running is not started: it reads the disk
 * when it starts. Applied before this returns, so a request sent next sees
 * the change. Rejects only for a server the profile does not declare.
 */
export function lspFilesChanged(events: { emit(channel: string, data: unknown): void }, report: LspFilesChanged): Promise<void> {
	let done: Promise<void> | undefined;
	events.emit(LSP_FILES_CHANGED_CHANNEL, { ...report, reply: (promise) => (done = promise) } satisfies LspFilesChangedEvent);
	return done ?? Promise.resolve();
}
