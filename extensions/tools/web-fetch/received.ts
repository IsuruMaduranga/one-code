/**
 * web_fetch's transcript row (pure): Claude Code's "Received 2.4KB (200 OK)".
 * The model reads the page or the reader's answer with its framing; the user
 * sees only what arrived.
 */

import { formatSize } from "../../lib/ui/text-width.ts";

/** What arrived: the response body's size in bytes and its HTTP status, when the tool fetched it itself. */
export interface Received {
	bytes?: number;
	status?: number;
	statusText?: string;
}

/** The row, or undefined when the result carries no size (the tool's text is drawn instead). */
export function receivedLine(details: Received | undefined): string | undefined {
	if (details?.bytes === undefined) return undefined;
	const status = details.status === undefined ? "" : ` (${[details.status, details.statusText].filter(Boolean).join(" ")})`;
	return `Received ${formatSize(details.bytes)}${status}`;
}
